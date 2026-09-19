/** The RPC message stream, independent of the DOM. message_end is authoritative. */
export type Content = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string };
export interface Message {
  role: string; content?: string | Content[]; timestamp?: number; attachments?: unknown;
  toolCallId?: string; toolName?: string; isError?: boolean; command?: string; output?: string; exitCode?: number;
  [key: string]: unknown;
}
export interface ToolResult { output: string; isError: boolean; state: 'running' | 'done' | 'failed' }
export const textOf = (m: Message): string => typeof m.content === 'string' ? m.content : (m.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
export class Conversation {
  messages: Message[] = [];
  tools = new Map<string, ToolResult>();
  private active = new Map<string, number>();
  private args = new Map<string, string>();
  reset(messages: Message[] = []) { this.messages = messages; this.tools.clear(); this.active.clear(); this.args.clear(); }
  ingest(p: Record<string, unknown>) {
    const type = p.type;
    if (type === 'message_start' || type === 'message_end') {
      const raw = p.message as Message | undefined;
      if (!raw?.role) return;
      // Detached snapshot: event objects must never be mutated by later deltas.
      const m = structuredClone(raw);
      const roleKey = m.role === 'toolResult' ? `tool:${m.toolCallId}` : m.role;
      const idx = this.active.get(roleKey);
      if (type === 'message_end' && idx !== undefined) { this.messages[idx] = m; this.active.delete(roleKey); }
      else { this.messages.push(m); if (type === 'message_start') this.active.set(roleKey, this.messages.length - 1); }
    } else if (type === 'message_update') {
      const d = p.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!d) return;
      let idx = this.active.get('assistant');
      if (idx === undefined) { idx = this.messages.length; this.messages.push({ role: 'assistant', content: [] }); this.active.set('assistant', idx); }
      const m = this.messages[idx];
      if (!Array.isArray(m.content)) m.content = [];
      const ci = Number(d.contentIndex ?? 0);
      if (!Number.isInteger(ci) || ci < 0 || ci > 10000) return;
      const kind = String(d.type ?? '');
      let b = m.content[ci];
      if (kind.startsWith('text_') || kind.startsWith('thinking_')) {
        const field = kind.startsWith('text_') ? 'text' : 'thinking';
        if (!b || b.type !== field) b = m.content[ci] = { type: field, [field]: '' };
        if (kind.endsWith('_delta')) b[field] = (b[field] ?? '') + String(d.delta ?? '');
        if (kind.endsWith('_end') && typeof d.content === 'string') b[field] = d.content;
      } else if (kind.startsWith('toolcall_')) {
        if (!b || b.type !== 'toolCall') b = m.content[ci] = { type: 'toolCall', id: String(d.id ?? ''), name: String(d.toolName ?? 'tool'), arguments: {} };
        const key = `${idx}:${ci}`;
        if (kind === 'toolcall_start') { b.id = String(d.id ?? b.id); b.name = String(d.toolName ?? b.name); this.args.set(key, ''); }
        if (kind === 'toolcall_delta') { const a = (this.args.get(key) ?? '') + String(d.delta ?? ''); this.args.set(key, a); try { b.arguments = JSON.parse(a); } catch { b.arguments = a; } }
        if (kind === 'toolcall_end' && d.toolCall) m.content[ci] = { ...(d.toolCall as Content), type: 'toolCall' };
      }
    } else if (String(type).startsWith('tool_execution_')) {
      const id = String(p.toolCallId ?? '');
      const old = this.tools.get(id) ?? { output: '', isError: false, state: 'running' as const };
      const result = (p.result ?? p.partialResult) as Message | undefined;
      this.tools.set(id, { output: result ? textOf(result) : old.output, isError: p.isError === true, state: type === 'tool_execution_end' ? p.isError ? 'failed' : 'done' : 'running' });
    }
  }
}
