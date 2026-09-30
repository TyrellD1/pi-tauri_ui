// Development-only transport fixture. The production entry drops this import.
// Every scenario uses index.html/main.ts and the same event path as native RPC.
import { setTauriOverride } from './tauri-shim';
import { Conversation, type Message } from './conversation';
const fixture = new Conversation();
let listener: ((ev: {payload: unknown}) => void) | null = null;
let cwd = '/projects/pi-tauri_ui', path = '/preview/chats/chat-0.jsonl', running = false, scenario = 'Populated';
let nextId = 0, listenAttempts = 0;
let rejectNext = false, holdSend: (() => void) | null = null, holdResponse: (() => void) | null = null;
let failNavigation = false;
let delayNewChat = false, releaseNewChat: (() => void) | null = null;
let failResponse = false, calls: {cmd: string; args?: Record<string, unknown>}[] = [];
let createdSessions: {path:string;id:string;name:string|null;preview:string;mtime:number;messageCount:number}[] = [];
let queued: string[] = [];
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clone = <T>(v: T): T => structuredClone(v);
const sleep = (ms = 30) => new Promise(r => setTimeout(r, ms));
function emit(p: Record<string, unknown>) {
  fixture.ingest(p);
  if (p.type === 'agent_start') running = true;
  if (p.type === 'agent_settled') running = false;
  // The real backend tags every event with its owning cwd + session so the UI
  // can route it to the right chat. Fixtures must do the same or per-chat
  // caches (queue, run state) never populate and the routing path goes untested.
  p.cwd = cwd;
  p.session = path;
  listener?.({payload: clone(p)});
}
function populated(): Message[] {
  return [
    {role:'user',content:'Can you simplify the chat interface and check the result?',timestamp:1},
    {role:'assistant',content:[{type:'thinking',thinking:'Start with hierarchy, then verify the interaction states.'},{type:'text',text:'## A quieter place to work\n\nThe conversation now leads. Tools sit in compact rows, and the controls you use most stay close to your message.\n\n- Clearer spacing and a consistent reading width\n- Model and thinking controls beside the composer\n- Errors with an obvious next step'}],timestamp:2},
    {role:'assistant',content:[{type:'toolCall',id:'preview-read',name:'read',arguments:{path:'src/main.ts'}},{type:'text',text:'The header only needs the chat title, conversation actions, and theme toggle.\n\n```ts\nconst actions = ["Session details", "Rename chat"];\n```\n\n| State | What you see |\n| --- | --- |\n| Ready | Message composer |\n| Running | Stop and follow-up controls |\n| Waiting | A clear permission request |'}],timestamp:3},
    {role:'assistant',content:[{type:'text',text:'Two files worth a look: docs/batch2-plan.md (plain) and `/Users/tydowner/workspace_a/projects/pi-tauri_ui/docs/pr-1-review-checklist.html` (backticked, absolute). Links like [the docs](https://example.com/x.md) stay links.'}],timestamp:5},
    {role:'toolResult',toolCallId:'preview-read',toolName:'read',content:[{type:'text',text:Array.from({length:240},(_,i)=>`Line ${i+1}: workspace view`).join('\n')}],timestamp:4},
  ];
}
function resetData() { fixture.reset(scenario === 'Populated' ? populated() : []); running = false; queued = []; }
function previewSessions() {
  const generated = Array.from({length:245},(_,i)=>({path:`/preview/chats/chat-${i}.jsonl`,id:String(i),name:i===0?'Refine the chat interface':null,preview:i===244?'Archived keyboard review':`Project conversation ${i+1}`,mtime:Date.now()-i*3600000,messageCount:10}));
  // Chats created in this session must list too — the real backend does, and
  // the sidebar expects the active chat to be present (queue/run-state checks
  // navigate back to it by position).
  return [...createdSessions, ...generated];
}
function user(message: string, images: unknown[] = []): Message {
  return {role:'user',content:[...(message ? [{type:'text',text:message}] : []), ...images.map(im=>({...(im as object),type:'image'}))],timestamp:Date.now()};
}
function accepted(message: string, images: unknown[] = []) {
  emit({type:'agent_start'}); const m = user(message,images); emit({type:'message_start',message:m}); emit({type:'message_end',message:m});
}
function finish() {
  emit({type:'agent_settled'});
}
function assistantStart() { emit({type:'message_start',message:{role:'assistant',content:[],timestamp:Date.now()}}); }
function delta(type: string, contentIndex: number, fields: Record<string, unknown>) { emit({type:'message_update',assistantMessageEvent:{type,contentIndex,...fields}}); }
function endAssistant() { const m = [...fixture.messages].reverse().find(m=>m.role==='assistant'); if(m) emit({type:'message_end',message:clone(m)}); }

export function installPreview() {
  resetData();
  setTauriOverride({
    listen: async (_event, cb) => {
      listenAttempts++;
      if (new URLSearchParams(location.search).has('listenerFailure') && listenAttempts === 1) throw new Error('Preview listener unavailable once');
      listener = cb; return () => { listener = null; };
    },
    invoke: async (cmd, args) => {
      calls.push({cmd,args:clone(args)});
      if(cmd === 'pi_get_state') {
        if(failNavigation) {failNavigation=false;return {success:false,error:'Preview session unavailable'};}
        // Scoped routing like the real pool: an explicit session wins, a new
        // folder presents its default, otherwise the current session holds.
        // An empty/absent cwd means "unknown yet" — the real backend falls back
        // to its own directory and reports that; mirror it instead of adopting
        // "", which would empty the project list.
        const reqCwd = typeof args?.cwd === 'string' ? args.cwd.trim() : '';
        const sp = args?.session;
        if(typeof sp === 'string' && sp) { path=sp; }
        else if(sp === null && reqCwd && reqCwd !== cwd) { cwd=reqCwd; path=`${cwd}/new.jsonl`; resetData(); }
        else if(reqCwd) { cwd=reqCwd; }
        return {cwd,sessionFile:path,sessionName:scenario === 'Populated'?'Refine the chat interface':'New chat',thinkingLevel:'xhigh',isStreaming:running,model:{provider:'opencode-go',id:'muse-spark-1.3-contributor'}};
      }
      if(cmd === 'pi_list_dirs') {
        const dir=String(args?.path ?? cwd);if(dir==='/missing') throw new Error('Folder not found');
        return {path:dir,parent:dir==='/'?null:dir.slice(0,dir.lastIndexOf('/')) || '/',home:'/Users/preview',dirs:dir==='/'?['/projects','/Users']:dir==='/projects'?['/projects/pi-tauri_ui','/projects/other']:[],truncated:false};
      }
      if(cmd === 'pi_get_messages') return {messages:clone(fixture.messages)};
      if(cmd === 'pi_list_sessions') return {sessions:previewSessions(),active:path};
      if(cmd === 'pi_all_projects') return {projects:[{slug:'--projects-pi-tauri_ui--',cwd,latest:Date.now(),sessions:previewSessions()}]};
      if(cmd === 'pi_get_models') return {models:[{provider:'opencode-go',id:'muse-spark-1.3-contributor'},{provider:'anthropic',id:'claude-sonnet-4'}],current:'opencode-go/muse-spark-1.3-contributor'};
      if(cmd === 'pi_get_commands') return {commands:[{name:'skill:image-gen',description:'Generate images from a prompt',source:'skill',location:'user'},{name:'skill:improve-prompt',description:'Refine a rough prompt',source:'skill',location:'project'}]};
      if(cmd === 'pi_get_stats') return {tokens:{input:2400,output:600,total:3000},cost:0.012};
      if(cmd === 'pi_new_chat') {
        if(delayNewChat) { delayNewChat=false; await new Promise<void>(resolve=>releaseNewChat=resolve); releaseNewChat=null; }
        path=`/preview/new-${++nextId}.jsonl`;
        createdSessions.unshift({path,id:`new-${nextId}`,name:null,preview:'New chat',mtime:Date.now(),messageCount:0});
        resetData(); return {success:true,path};
      }
      if(cmd === 'pi_prompt' || cmd === 'pi_steer' || cmd === 'pi_follow_up') {
        if(rejectNext) { rejectNext=false; await new Promise<void>(r=>holdSend=r); holdSend=null; return {success:false,error:'Preview rejection'}; }
        const msg = String(args?.message ?? 'Image'), imgs = (args?.images as unknown[]) ?? [];
        if(cmd === 'pi_prompt') accepted(msg, imgs);
        else {
          // Real pi echoes a steering message into the transcript immediately;
          // follow-ups stay queued until the turn ends.
          if(cmd === 'pi_steer') { const m = user(msg, imgs); emit({type:'message_start',message:m}); emit({type:'message_end',message:m}); }
          else queued.push(msg);
          emit({type:'queue_update',steering:[],followUp:queued});
        }
        return {accepted:true,success:true};
      }
      if(cmd === 'pi_abort') { finish(); return {success:true}; }
      if(cmd === 'pi_clear_queue') { queued=[]; emit({type:'queue_update',steering:[],followUp:[]}); return {success:true}; }
      if(cmd === 'pi_ui_response') {
        if(failResponse) { failResponse=false; await new Promise<void>(r=>holdResponse=r); holdResponse=null; throw new Error('Preview response failed'); }
        return {ok:true};
      }
      if(cmd === 'pi_export') return {path:'/preview/export.html'};
      if(cmd === 'pi_open_path') return {ok:true};
      if(cmd === 'pi_git_branch') return {branch:'preview-branch'};
      return {success:true};
    }
  });
  const panel=document.createElement('details'); panel.id='dev-panel';
  panel.style.cssText='position:fixed;left:12px;bottom:60px;z-index:80;width:200px;max-height:60vh;overflow:auto;background:var(--page);border:1px solid var(--line);border-radius:8px;padding:8px;font:12px var(--font);box-shadow:0 4px 16px #0001';
  const summary=document.createElement('summary'); summary.textContent='Preview scenarios'; panel.append(summary);
  const select=document.createElement('select'); select.setAttribute('aria-label','Preview scenario'); select.style.cssText='width:100%;margin:8px 0;background:var(--surface);color:var(--ink)';
  for(const s of ['Populated','Empty','Streaming','Permissions','Rejected send']) { const o=document.createElement('option');o.textContent=s;select.append(o); } panel.append(select);
  const button=(label:string,fn:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='display:block;width:100%;margin:6px 0;padding:5px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:5px';b.onclick=fn;panel.append(b);return b;};
  button('Load scenario',()=>void loadScenario(select.value));
  button('Next stream step',()=>streamStep());
  button('Release rejection',()=>holdSend?.());
  // The suite reads real persisted state (drafts, groups, expanded, dots), so
  // repeated runs in one profile drift and produce false failures. Reset first
  // for a deterministic run.
  button('Reset preview state',()=>{ for(const k of Object.keys(localStorage)) if(k.startsWith('pi-')) localStorage.removeItem(k); location.reload(); });
  const run=button('Run UI regression',()=>void runRegression());
  const uxRun=button('Run UX audit checks',()=>void runUXRegression());
  const result=document.createElement('pre'); result.id='dev-results';result.style.cssText='white-space:pre-wrap;font:11px/1.5 var(--font)';panel.append(result);
  document.body.append(panel);
  async function runUXRegression() {
    uxRun.disabled=true;run.disabled=true; result.textContent='Running UX checks…'; const report:string[]=[];
    const check=(name:string,ok:boolean)=>{report.push(`${ok?'PASS':'FAIL'} ${name}`);result.textContent=report.join('\n');if(!ok)throw new Error(name);};
    const key=(el:HTMLElement,key:string,extra:KeyboardEventInit={})=>el.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,...extra}));
    const findButton=(root:HTMLElement,label:string)=>Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===label)!;
    const originalGroups=localStorage.getItem('pi-chat-groups'), originalParents=localStorage.getItem('pi-parents');
    try {
      await loadScenario('Empty');type('My unfinished question');
      $('messages-inner').querySelector<HTMLButtonElement>('.empty-actions button')!.click();
      check('starter keeps an existing draft',$<HTMLTextAreaElement>('input').value==='My unfinished question');
      $('btn-settings').click();const modal=$('modal-root').querySelector<HTMLElement>('.modal')!;
      check('modal makes both background panels inert',$('main').inert && $('sidebar').inert);
      const beforeNew=calls.filter(c=>c.cmd==='pi_new_chat').length;key(modal,'n',{metaKey:true});
      check('global new-chat shortcut cannot leave a modal',calls.filter(c=>c.cmd==='pi_new_chat').length===beforeNew);
      $<HTMLInputElement>('m-cwd').value='';findButton(modal,'Save').click();
      check('empty project path stays open with field error',$('modal-root').contains(modal) && $('m-cwd').getAttribute('aria-invalid')==='true');
      const theme=$<HTMLSelectElement>('m-theme');theme.value='dark';theme.dispatchEvent(new Event('change'));
      check('dark preference updates theme and toggle',document.documentElement.dataset.theme==='dark' && $('btn-theme').getAttribute('aria-label')==='Switch to light theme');
      theme.value='system';theme.dispatchEvent(new Event('change'));
      check('system preference removes manual override',localStorage.getItem('pi-theme')===null && document.documentElement.dataset.themePreference==='system');
      const save=findButton(modal,'Save');save.focus();key(save,'Tab');
      check('Tab wraps within modal',document.activeElement===$('m-cwd'));
      findButton(modal,'Cancel').click();await sleep();
      check('closing modal restores background access',!$('main').inert && (!$('sidebar').inert || matchMedia('(max-width:760px)').matches));
      if($('app').dataset.sidebar==='closed')$('btn-sidebar').click();
      $('chat-list').querySelector<HTMLButtonElement>('[aria-label="New group"]')!.click();
      const groupModal=$('modal-root');findButton(groupModal,'Create').click();
      check('empty group name stays open with a field error',$('m-group').getAttribute('aria-invalid')==='true');
      $<HTMLInputElement>('m-group').value='UX audit group';findButton(groupModal,'Create').click();await sleep();
      const group=$('chat-list').querySelector<HTMLElement>('[data-group="UX audit group"]')!;
      group.querySelector<HTMLButtonElement>('.p-x')!.click();
      check('group deletion provides Undo',!!Array.from($('notices').querySelectorAll('button')).find(b=>b.textContent==='Undo'));
      findButton($('notices'),'Undo').click();
      check('Undo restores the group',!!$('chat-list').querySelector('[data-group="UX audit group"]'));
      // A real large group must page, and the entire sidebar must stay bounded.
      const all=previewSessions().map(s=>s.path);localStorage.setItem('pi-chat-groups',JSON.stringify({'Large audit group':all}));
      typeSearch('temporary');await sleep(180);typeSearch('');await sleep(180);
      check('all sidebar sections share a 200-chat cap',$('chat-list').querySelectorAll('.chat-item').length<=200);
      let large=$('chat-list').querySelector<HTMLElement>('[data-group="Large audit group"]')!;
      check('large groups have page controls',large.querySelectorAll('.chat-item').length===100 && !!findButton(large,'Older chats'));
      findButton(large,'Older chats').click();large=$('chat-list').querySelector<HTMLElement>('[data-group="Large audit group"]')!;
      check('paging reaches older group chats',large.querySelector<HTMLButtonElement>('.chat-item')?.dataset.path===all[100]);
      localStorage.setItem('pi-parents',JSON.stringify({recent:false,groups:false,projects:false}));
      typeSearch('Archived keyboard review');await sleep(180);
      check('search reaches chats with every section closed',$('chat-list').querySelector('.chat-item')?.textContent?.includes('Archived keyboard review')===true);
      const resultRow=$('chat-list').querySelector<HTMLElement>('.chat-item')!;resultRow.focus();const focusKey=resultRow.dataset.focusKey;
      emit({type:'agent_start'});await sleep(70);
      check('sidebar refresh keeps the focused chat',(document.activeElement as HTMLElement).dataset.focusKey===focusKey);
      const aborts=calls.filter(c=>c.cmd==='pi_abort').length;
      const search=$<HTMLInputElement>('search');search.focus();key(search,'Escape');
      check('search Escape clears only the search',search.value==='' && calls.filter(c=>c.cmd==='pi_abort').length===aborts);
      // Keep the context button focused while the real streaming path updates prose.
      assistantStart();await sleep(70);
      const context=$('chat-context').querySelector<HTMLElement>('button')!;context.focus();
      delta('text_delta',0,{delta:'A streamed update.'});await sleep(70);
      check('streaming keeps the context control and focus',context===$('chat-context').querySelector('button') && document.activeElement===context);
      type('$image');await sleep(50);const input=$<HTMLTextAreaElement>('input');
      check('skill suggestions expose the active option',input.getAttribute('aria-expanded')==='true' && !!document.getElementById(input.getAttribute('aria-activedescendant')!));
      key(input,'Escape');
      check('skill Escape does not stop the turn',input.getAttribute('aria-expanded')==='false' && calls.filter(c=>c.cmd==='pi_abort').length===aborts);
      finish();await sleep(70);
      // Different processes can reuse a dialog id. Background editor/status events must not change this chat.
      const activeTitle=$('chat-title').textContent;type('Visible draft');
      const away=(event:Record<string,unknown>)=>listener?.({payload:{...event,cwd:'/projects/background',session:'/preview/background.jsonl'}});
      away({type:'extension_ui_request',method:'set_editor_text',text:'Wrong draft'});
      away({type:'extension_ui_request',method:'setTitle',title:'Wrong title'});
      check('background extension updates keep visible title and draft',$<HTMLTextAreaElement>('input').value==='Visible draft' && $('chat-title').textContent===activeTitle);
      away({type:'extension_ui_request',method:'confirm',id:'same-id',title:'Background permission',message:'Run a background command?'});
      emit({type:'extension_ui_request',method:'confirm',id:'same-id',title:'Visible permission',message:'Run here?'});
      check('dialog ids are unique per owning chat',$('dialog-slot').children.length===2 && $('dialog-slot').textContent!.includes('Request from'));
      findButton($('dialog-slot'),'No').click();await sleep(60);
      const response=[...calls].reverse().find(c=>c.cmd==='pi_ui_response');
      check('background response uses the requesting chat',response?.args?.cwd==='/projects/background' && response?.args?.session==='/preview/background.jsonl' && response?.args?.id==='same-id');
      findButton($('dialog-slot'),'No').click();await sleep(60);
      check('visible request survives the background response',$('dialog-slot').children.length===0);
      if(!matchMedia('(max-width:760px)').matches) {
        const grip=$('side-grip');const old=Number(grip.getAttribute('aria-valuenow'));grip.focus();key(grip,'ArrowRight');
        check('sidebar resizes from the keyboard',Number(grip.getAttribute('aria-valuenow'))>old);key(grip,'Home');
      }
      // Switching back to ordinary groups does not lose a searchable chat.
      if(originalGroups===null)localStorage.removeItem('pi-chat-groups');else localStorage.setItem('pi-chat-groups',originalGroups);
      localStorage.setItem('pi-parents',JSON.stringify({recent:false,groups:true,projects:true}));typeSearch('');await sleep(180);
      const actions=$('chat-list').querySelector<HTMLButtonElement>('.chat-actions')!;actions.focus();actions.click();
      check('chat actions are available without right-click',!!$('menu-root').querySelector('[role="menu"]'));
      key($('menu-root').querySelector<HTMLElement>('[role="menu"]')!,'Escape');
      check('closing chat actions restores focus',document.activeElement===actions);
      const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jbasAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'test.png',{type:'image/png'}));
      type('');$('composer-wrap').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));await sleep(80);$('btn-send').click();await sleep(70);finish();await sleep(70);
      const image=$('messages-inner').querySelector<HTMLImageElement>('.msg-img')!;key(image,'Enter');
      check('attached images zoom by keyboard',image.classList.contains('full') && image.getAttribute('aria-expanded')==='true');
      key(image,' ');check('image keyboard toggle shrinks again',!image.classList.contains('full'));
      $('chat-context').querySelector<HTMLButtonElement>('button')!.click();await sleep(70);
      const picker=$('modal-root');const folderSearch=picker.querySelector<HTMLInputElement>('[aria-label="Search folders or type a path"]')!;
      check('folder picker has a clear empty-folder state',picker.textContent!.includes('No subfolders here') && !findButton(picker,'Start chat here').disabled);
      folderSearch.value='/missing';key(folderSearch,'Enter');await sleep(60);
      check('folder failure keeps the last valid folder selectable',picker.textContent!.includes('Check the path') && !findButton(picker,'Start chat here').disabled);
      // A request arriving behind Settings takes focus after Settings closes.
      findButton(picker,'Cancel').click();$('btn-settings').click();
      emit({type:'extension_ui_request',method:'confirm',id:'late',title:'Request behind settings',message:'Please answer after closing Settings.'});
      findButton($('modal-root'),'Cancel').click();await sleep(30);
      check('closing settings focuses a waiting request',$('dialog-slot').contains(document.activeElement));
      findButton($('dialog-slot'),'No').click();await sleep(50);
      const createsBefore=calls.filter(c=>c.cmd==='pi_new_chat').length;delayNewChat=true;
      $('btn-new').click();await sleep(20);
      check('new chat shows immediate pending feedback',$<HTMLButtonElement>('btn-new').disabled && $('btn-new').textContent!.includes('Creating'));
      $('btn-new').click();$('chat-list').querySelector<HTMLButtonElement>('.p-add')?.click();
      check('repeated new-chat actions create one session',calls.filter(c=>c.cmd==='pi_new_chat').length===createsBefore+1);
      releaseNewChat?.();await sleep(100);


      result.textContent=report.join('\n')+`\n\n${report.length} UX checks passed.`;
    } catch(e) {result.textContent=report.join('\n')+`\nSTOPPED: ${String(e)}`;}
    finally {
      for(const [name,value] of [['pi-chat-groups',originalGroups],['pi-parents',originalParents]] as const) {
        if(value===null)localStorage.removeItem(name);else localStorage.setItem(name,value);
      }
      uxRun.disabled=false;run.disabled=false;
    }
  }
  async function runRegression() {
    run.disabled=true; result.textContent='Running actual UI checks…'; const report:string[]=[];
    const check=(name:string,ok:boolean)=>{report.push(`${ok?'PASS':'FAIL'} ${name}`);result.textContent=report.join('\n');if(!ok)throw new Error(name);};
    try {
      if($('messages-inner').textContent?.includes("Couldn't connect")) { const b=Array.from($('messages-inner').querySelectorAll('button')).find(b=>b.textContent==='Retry connection'); b?.click(); await sleep(100); }
      check('listener recovered and boot completed',!$('input').hasAttribute('disabled') && listenAttempts >= 1);
      await loadScenario('Empty');
      const input=$<HTMLTextAreaElement>('input');
      rejectNext=true; type('first rejected snapshot'); $('btn-send').click(); await sleep(); type('newer draft stays here');
      const before=calls.filter(c=>c.cmd==='pi_prompt').length;
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      check('double submit blocked',calls.filter(c=>c.cmd==='pi_prompt').length===before);
      holdSend?.(); await sleep(80);
      check('rejection preserves newer draft',input.value==='newer draft stays here' && $('messages-inner').textContent!.includes('Not sent'));
      check('rejection exits running state',$('btn-stop').classList.contains('hidden'));
      $('messages-inner').querySelector<HTMLButtonElement>('.retry-btn')!.click(); await sleep(80);
      check('retry sends original snapshot',[...calls].reverse().find(c=>c.cmd==='pi_prompt')?.args?.message==='first rejected snapshot' && input.value==='newer draft stays here');
      check('optimistic user reconciled once',$('messages-inner').querySelectorAll('.user-bubble').length===1);
      assistantStart(); delta('text_delta',0,{delta:'Before the tool.'}); delta('toolcall_start',1,{id:'ordered-tool',toolName:'bash'}); delta('toolcall_delta',1,{delta:'{"command":"npm test"}'}); delta('toolcall_end',1,{toolCall:{id:'ordered-tool',name:'bash',arguments:{command:'npm test'}}}); endAssistant();
      emit({type:'tool_execution_start',toolCallId:'ordered-tool',toolName:'bash'});
      const output=Array.from({length:240},(_,i)=>`output ${i}`).join('\n'); emit({type:'tool_execution_end',toolCallId:'ordered-tool',result:{content:[{type:'text',text:output}]},isError:false});
      emit({type:'message_start',message:{role:'toolResult',toolCallId:'ordered-tool',content:[{type:'text',text:output}]}}); emit({type:'message_end',message:{role:'toolResult',toolCallId:'ordered-tool',content:[{type:'text',text:output}]}});
      await sleep(60); const tool=$('messages-inner').querySelector<HTMLElement>('[data-tool="tool-ordered-tool"]')!;tool.click();tool.focus();
      const oldTool=tool, out=tool.parentElement!.querySelector<HTMLElement>('.tool-output')!;out.scrollTop=120;const scroll=out.scrollTop;
      const prose=$('messages-inner').querySelector<HTMLElement>('.md')!;
      const range=document.createRange();range.selectNodeContents(prose);const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);
      assistantStart();delta('text_delta',0,{delta:'After the tool.'});await sleep(60);
      check('text, tool, text remain ordered',Array.from($('messages-inner').children).map(n=>n.textContent).join('|').match(/Before the tool[\s\S]*Run command[\s\S]*After the tool/) !== null);
      check('tool node, focus and scroll survive',oldTool===$('messages-inner').querySelector('[data-tool="tool-ordered-tool"]') && document.activeElement===oldTool && out.scrollTop===scroll);
      check('earlier text selection survives',selection.toString()==='Before the tool.'); selection.removeAllRanges();
      endAssistant();finish();await sleep(100);
      check('settle preserves disclosure node and expansion',oldTool===$('messages-inner').querySelector('[data-tool="tool-ordered-tool"]') && oldTool.getAttribute('aria-expanded')==='true');
      const more=Array.from(oldTool.parentElement!.querySelectorAll('button')).find(b=>b.textContent?.startsWith('Show full output'))!;more.click();
      check('full output reachable',out.textContent?.includes('output 239')===true);
      // Chat paths (idea 2): plain and backticked .md/.html linkify; clicking
      // one calls the allowlisted opener with the visible cwd.
      emit({type:'message_start',message:{role:'assistant',content:[{type:'text',text:'See docs/batch2-plan.md and `docs/pr-1-review-checklist.html` plus [a link](https://example.com/x.md).'}]}});
      emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'See docs/batch2-plan.md and `docs/pr-1-review-checklist.html` plus [a link](https://example.com/x.md).'}]}});
      await sleep(60);
      const pathLinks=Array.from($('messages-inner').querySelectorAll<HTMLButtonElement>('.path-link'));
      check('plain and backticked paths linkify, links do not',
        pathLinks.length===2 && pathLinks[0].textContent==='docs/batch2-plan.md' && pathLinks[1].classList.contains('in-code'));
      check('fenced paths stay plain',!$('messages-inner').querySelector('.codeblock .path-link'));
      const beforeOpen=calls.filter(c=>c.cmd==='pi_open_path').length;
      pathLinks[0].click(); await sleep(80);
      const opened=[...calls].reverse().find(c=>c.cmd==='pi_open_path');
      check('path click opens with explicit cwd',
        calls.filter(c=>c.cmd==='pi_open_path').length===beforeOpen+1 && opened?.args?.path==='docs/batch2-plan.md' && typeof opened?.args?.cwd==='string');
      type('same message');$('btn-send').click();await sleep(50);finish();await sleep(70);type('same message');$('btn-send').click();await sleep(50);finish();await sleep(70);
      check('identical consecutive messages retained',Array.from($('messages-inner').querySelectorAll('.user-bubble')).filter(n=>n.textContent==='same message').length===2);
      emit({type:'extension_ui_request',method:'confirm',id:'a',title:'Permission A',message:'Allow this command?'});
      const card=$('dialog-slot').firstElementChild!;
      emit({type:'extension_ui_request',method:'notify',message:'Background notice'});emit({type:'extension_ui_request',method:'setStatus',statusText:'Working'});
      emit({type:'extension_ui_request',method:'confirm',id:'b',title:'Permission B',message:'Allow next command?'});
      check('notifications preserve permission and queue',card===$('dialog-slot').firstElementChild && $('dialog-slot').children.length===2);
      failResponse=true;Array.from(card.querySelectorAll('button')).find(b=>b.textContent==='No')!.click();await sleep();
      const responseCount=calls.filter(c=>c.cmd==='pi_ui_response').length;
      card.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      check('permission in-flight guard',calls.filter(c=>c.cmd==='pi_ui_response').length===responseCount);
      holdResponse?.();await sleep();
      const retry=Array.from(card.querySelectorAll('button')).find(b=>b.textContent==='Retry response');check('permission failure explicitly retryable',!!retry);retry!.click();await sleep();
      check('response A cannot clear B',$('dialog-slot').textContent!.includes('Permission B') && !$('dialog-slot').firstElementChild?.classList.contains('hidden'));
      Array.from($('dialog-slot').querySelectorAll('button')).find(b=>b.textContent==='No')!.click();await sleep();
      await loadScenario('Empty');
      type('IME composition'); const beforeIme=calls.length;
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));
      check('IME Enter never sends',calls.length===beforeIme && input.value==='IME composition');
      type('running task');$('btn-send').click();await sleep(60);
      $('btn-menu').click(); const aborts=calls.filter(c=>c.cmd==='pi_abort').length;
      $('menu-root').querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      check('Escape closes menu without aborting turn',!$('menu-root').children.length && calls.filter(c=>c.cmd==='pi_abort').length===aborts);
      type('queued after this');$('btn-queue').click();await sleep(50);
      check('follow-up visibly queued',$('queue-bar').textContent!.includes('follow-up: queued after this'));
      type('steering correction');rejectNext=true;$('btn-send').click();await sleep();type('new steering draft');holdSend?.();await sleep(60);
      check('rejected steering preserves draft and running state',input.value==='new steering draft' && !$('btn-stop').classList.contains('hidden'));
      $('btn-stop').click();await sleep(90);
      check('Stop settles without silently clearing queue',$('btn-stop').classList.contains('hidden') && $('queue-bar').textContent!.includes('queued after this'));
      $('queue-bar').querySelector<HTMLButtonElement>('button')!.click();await sleep();
      check('explicit Clear empties queue',$('queue-bar').classList.contains('hidden'));
      type('bg task');$('btn-send').click();await sleep(60);
      type('queued while running');$('btn-queue').click();await sleep(50);
      $('chat-list').querySelectorAll<HTMLButtonElement>('.chat-item')[1].click();await sleep(80);
      check('queue hidden on other chat',$('queue-bar').classList.contains('hidden'));
      $('chat-list').querySelectorAll<HTMLButtonElement>('.chat-item')[0].click();await sleep(80);
      check('queue survives chat switch',$('queue-bar').textContent!.includes('queued while running'));
      const home=$('chat-list').querySelector<HTMLButtonElement>('.chat-item')!;home.click();await sleep(80);
      type('');
      const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jbasAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'test.png',{type:'image/png'}));
      $('composer-wrap').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));await sleep(80);
      check('attachment-only draft is sendable',!$<HTMLButtonElement>('btn-send').disabled && $('attach-strip').querySelectorAll('img').length===1);
      const savedPath=path;failNavigation=true;$('chat-list').querySelectorAll<HTMLButtonElement>('.chat-item')[1].click();await sleep(60);
      check('failed switch keeps exactly one attachment',path===savedPath && $('attach-strip').querySelectorAll('img').length===1);
      $('chat-list').querySelectorAll<HTMLButtonElement>('.chat-item')[1].click();await sleep(70);
      check('attachment draft stays with original chat',$('attach-strip').querySelectorAll('img').length===0);
      $('chat-list').querySelectorAll<HTMLButtonElement>('.chat-item')[0].click();await sleep(70);
      check('returning restores attachment-only draft',$('attach-strip').querySelectorAll('img').length===1);
      $('btn-send').click();await sleep(60);finish();await sleep(80);
      check('attachment-only message reconciles once',$('messages-inner').querySelectorAll('.user-block img').length===1);
      type('$image');await sleep(80);
      check('skill popup lists matches',$('skill-pop')?.querySelectorAll('.menu-item').length===1);
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await sleep(30);
      check('skill inserts canonical name',input.value.includes('/skill:image-gen'));
      check('skill popup closes on accept',$('skill-pop').classList.contains('hidden'));
      const chatsBefore=calls.filter(c=>c.cmd==='pi_new_chat').length;
      $('chat-list').querySelector<HTMLButtonElement>('.p-add')!.click();await sleep(100);
      check('project plus starts new chat',input.value==='' && calls.filter(c=>c.cmd==='pi_new_chat').length===chatsBefore+1);
      $('chat-list').querySelector<HTMLButtonElement>('.chat-item')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:60,clientY:60}));await sleep(60);
      check('chat context menu opens',!!$('menu-root').querySelector('.menu-item'));
      Array.from($('menu-root').querySelectorAll('button')).find(b=>b.textContent?.includes('Add to group'))!.click();await sleep(30);
      Array.from($('menu-root').querySelectorAll('button')).find(b=>b.textContent?.includes('New group'))!.click();await sleep(30);
      ($('modal-root').querySelector('#m-group') as HTMLInputElement).value='Testers';
      Array.from($('modal-root').querySelectorAll('button')).find(b=>b.textContent==='Create')!.click();await sleep(60);
      check('new group holds the chat',$('chat-list').textContent!.includes('Testers'));
      type('saved with first chat');const firstPath=path;$('btn-new').click();await sleep(80);
      check('new chat has its own draft',input.value==='');
      // Navigation through real Settings needs no respawn: one scoped state
      // load moves folders, and no process is ever spawned to switch.
      const routed=calls.length;$('btn-settings').click();$<HTMLInputElement>('m-cwd').value='/projects/other';
      Array.from($('modal-root').querySelectorAll('button')).find(b=>b.textContent==='Save')!.click();await sleep(100);
      check('folder change needs no respawn',cwd==='/projects/other' && !calls.slice(routed).some(c=>['pi_spawn','pi_set_cwd','pi_new_session','pi_switch_session'].includes(c.cmd)));
      // The cap is per project listing: the active project renders a 100-chat
      // window, so the DOM stays bounded no matter how many sessions exist.
      // (Groups may add their own rows, so scope this to the project section.)
      const projBox=[...$('chat-list').querySelectorAll('.project-section')].find(s=>s.getAttribute('aria-label')===cwd);
      check('session list stays bounded',projBox?.querySelectorAll('.chat-item').length===100);
      typeSearch('Archived keyboard review');await sleep(200);check('search reaches chat beyond 200',$('chat-list').textContent!.includes('Archived keyboard review'));
      check('session changed away from source',path!==firstPath);
      type('draft through disconnect');const reconnectPath=path;emit({type:'process_disconnected'});await sleep();
      check('disconnect disables send and retains draft',$<HTMLButtonElement>('btn-send').disabled && input.value==='draft through disconnect');
      Array.from($('messages-inner').querySelectorAll('button')).find(b=>b.textContent==='Retry connection')!.click();await sleep(120);
      check('reconnect resumes same chat and draft',path===reconnectPath && input.value==='draft through disconnect' && !$<HTMLButtonElement>('btn-send').disabled);
      typeSearch('');await sleep(200);await loadScenario('Populated');
      check('tables render without literal syntax',!!$('messages-inner').querySelector('table'));
      result.textContent=report.join('\n')+`\n\n${report.length} checks passed.`;
    } catch(e) {result.textContent=report.join('\n')+`\nSTOPPED: ${String(e)}`;}
    finally {run.disabled=false;}
  }
}
function type(text:string) { const input=$<HTMLTextAreaElement>('input');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true})); }
function typeSearch(text:string) { const input=$<HTMLInputElement>('search');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true})); }
let step=0;
async function loadScenario(name:string) {
  if(running) {finish();await sleep(80);}
  scenario=name;step=0;$('btn-new').click();await sleep(100);
  if(name==='Streaming') {accepted('Review the interface while I keep working.');streamStep();}
  if(name==='Permissions') emit({type:'extension_ui_request',method:'confirm',id:`permission-${++nextId}`,title:'Run the build?',message:'pi wants to run npm run build in your project folder.'});
  if(name==='Rejected send') {rejectNext=true;type('Please check the latest changes');$('btn-send').click();await sleep();type('A newer draft, safely kept');holdSend?.();}
}
function streamStep() {
  if(step===0) {assistantStart();delta('text_delta',0,{delta:'I’ll inspect the layout first, then check the build.'});}
  if(step===1) {delta('toolcall_start',1,{id:'stream-tool',toolName:'bash'});delta('toolcall_end',1,{toolCall:{id:'stream-tool',name:'bash',arguments:{command:'npm run build'}}});endAssistant();emit({type:'tool_execution_start',toolCallId:'stream-tool',toolName:'bash'});}
  if(step===2) {emit({type:'tool_execution_end',toolCallId:'stream-tool',result:{content:[{type:'text',text:'Build passed. 46 kB frontend.'}]}});assistantStart();delta('text_delta',0,{delta:'The build passes. The composer and conversation now share a clear left edge.'});}
  if(step===3) {endAssistant();finish();}step++;
}
