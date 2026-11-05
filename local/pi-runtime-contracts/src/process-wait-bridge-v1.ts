export interface ProcessWaitBridgeV1{readonly version:1;readonly sessionId:string;beforeContinuation():Promise<void>}
const CELL=Symbol.for("pi.subagents.process-wait-bridge.v1");
interface Cell{readonly bySession:Map<string,ProcessWaitBridgeV1>}
function cell(): Cell {
  const root = globalThis as typeof globalThis & { [CELL]?: Cell };
  const descriptor = Object.getOwnPropertyDescriptor(root, CELL);
  if (descriptor) {
    const holder: unknown = descriptor.value;
    const sessions = holder && typeof holder === "object" && !Array.isArray(holder)
      ? Object.getOwnPropertyDescriptor(holder, "bySession") : undefined;
    if (!sessions || !("value" in sessions) || !(sessions.value instanceof Map)) {
      throw new Error("incompatible Process wait bridge v1 holder");
    }
    return holder as Cell;
  }
  return root[CELL] = Object.freeze({ bySession: new Map() }) as Cell;
}
export function registerProcessWaitBridgeV1(bridge:ProcessWaitBridgeV1):{dispose():void}{if(!bridge||bridge.version!==1||typeof bridge.sessionId!=="string"||!bridge.sessionId||typeof bridge.beforeContinuation!=="function")throw new Error("invalid Process wait bridge");const c=cell();if(c.bySession.has(bridge.sessionId))throw new Error("Process wait bridge already registered");c.bySession.set(bridge.sessionId,bridge);let active=true;return Object.freeze({dispose(){if(!active)return;active=false;if(c.bySession.get(bridge.sessionId)===bridge)c.bySession.delete(bridge.sessionId);}});}
export function getProcessWaitBridgeV1(sessionId:string):ProcessWaitBridgeV1|undefined{return cell().bySession.get(sessionId);}
