// Seam for chats made by code (idea 7).
//
// An external script cannot invoke Tauri commands directly, so creation goes
// through ONE of:
//   1. In the app: right-click empty sidebar -> "New coded chat…"
//      (name + optional group + optional first message).
//   2. A future pi extension calling the `pi_coded_chat` Tauri command with:
//        { cwd, name, first_message?: string | null }
//      then assigning the returned `{ path }` to a group. The frontend
//      assigns groups only after the path is listed (see newCodedChat).
//
// Naming: the backend prefixes names with `[code] `. The app badges such
// rows (plus a localStorage `pi-coded-chats` set, since session names may
// not persist in session files) and prunes the set like groups.
//
// Usage: node scripts/new-coded-chat.mjs --name nightly-review [--group agents] [--message "..."]
// Prints the exact Tauri payload to send; it does not create anything itself.
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const name = get("--name");
if (!name || !name.trim()) {
  console.error("usage: node scripts/new-coded-chat.mjs --name <name> [--group <group>] [--message <text>]");
  process.exit(1);
}
const payload = {
  command: "pi_coded_chat",
  params: {
    cwd: "<project folder>",
    name: name.trim(),
    first_message: get("--message") ?? null,
  },
  then: "assign returned path to group " + JSON.stringify(get("--group") ?? "(none)") + " via newCodedChat in src/main.ts",
};
console.log(JSON.stringify(payload, null, 2));
