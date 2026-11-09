// 只回复公开 collect-materials/recovery DTO；不解析外部插件存储或重演其注入逻辑。
export function recoveryOwner(pi: any, contribution: { owner: string; customType: string; content: string; order: number; covers?: string[] }) {
  pi.events.on("pi-session-compact:collect-recovery-v1", (request: any) => {
    request.reply({ ...contribution, identity: { fixture: true } });
  });
}
export function skillMaterial(pi: any, skill: { sourceEntryId: string; name: string; path: string; contents: string }) {
  pi.events.on("pi-session-compact:collect-materials-v1", (request: any) => {
    request.reply({ owner: "fixture-rules", skills: [skill] });
  });
}
