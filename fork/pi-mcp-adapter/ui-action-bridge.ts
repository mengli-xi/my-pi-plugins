/** Embedded in the trusted host page. Keep this function self-contained. */
export function createUiActionQueue(
  sessionId: string,
  post: (path: string, params: Record<string, unknown>) => Promise<unknown>,
  failed: (id: string, error: unknown) => void,
  accepted: (id: string) => void,
) {
  let sequence = 0;
  let running = false;
  let blocked = false;
  const queue: Array<{
    id: string; path: string; body: string;
    resolve: (value: unknown) => void; reject: (error: unknown) => void;
    reply?: (id: string, ok: boolean, error?: string) => void;
  }> = [];
  const pump = async () => {
    if (running || blocked || queue.length === 0) return;
    running = true;
    const action = queue[0]!;
    try {
      // Parse the original bytes, never rebuild an action from mutable App data.
      const result = await post(action.path, JSON.parse(action.body));
      action.reply?.(action.id, true);
      accepted(action.id);
      action.resolve(result);
      queue.shift();
    } catch (error) {
      blocked = true;
      action.reply?.(action.id, false, String(error));
      action.reject(error);
      failed(action.id, error);
    } finally {
      running = false;
    }
    if (!blocked) void pump();
  };
  return {
    submit(path: string, params: Record<string, unknown>, reply?: (id: string, ok: boolean, error?: string) => void) {
      const id = `ui:${sessionId}:${sequence + 1}`;
      const body = JSON.stringify({ ...params, deliveryId: id });
      sequence += 1;
      const result = new Promise((resolve, reject) => {
        queue.push({ id, path, body, resolve, reject, ...(reply ? { reply } : {}) });
      });
      void pump();
      return result;
    },
    retry(id?: string) {
      if (!blocked || !queue[0] || (id !== undefined && queue[0].id !== id)) return false;
      blocked = false;
      void pump();
      return true;
    },
  };
}
