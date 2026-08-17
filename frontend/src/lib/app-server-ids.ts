/**
 * Stable numeric-id derivation shared between the transport and UI.
 *
 * The app-server addresses threads by UUID, but the sidebar/runtime/tab
 * system keys conversations by NUMBER. These two helpers map a thread UUID /
 * absolute path to the same stable positive integers the transport mints for
 * `list_all_conversations`, so a UI affordance (e.g. "open sub-agent session
 * as a tab") can compute the same id the transport will later resolve back to
 * the thread via `_threadIdByConvId`.
 */

/** Map a thread UUID to a stable positive numeric conversation id. Kept within
 *  i32 range (< 2^31-1) so Tauri's `get_folder_conversation` invoke accepts
 *  it, and BELOW 1_000_000_000 so it never collides with the
 *  `fallbackConversationId` space reserved for in-flight new-chat tabs. Must
 *  stay in sync with `OrbiterXTransport.convIdFromThreadId`. */
export function convIdFromThreadId(threadId: string): number {
  let h = 5381
  for (let i = 0; i < threadId.length; i++) {
    h = (h * 33) ^ threadId.charCodeAt(i)
  }
  return ((h >>> 0) % 999_999_999) + 1
}

/** Map an absolute path to a stable sidebar folder id (positive integer). Must
 *  stay in sync with `OrbiterXTransport.folderIdFromPath`. */
export function folderIdFromPath(cwd: string): number {
  let h = 5381
  for (let i = 0; i < cwd.length; i++) {
    h = (h * 33) ^ cwd.charCodeAt(i)
  }
  return ((h >>> 0) % 2_000_000_000) + 1
}
