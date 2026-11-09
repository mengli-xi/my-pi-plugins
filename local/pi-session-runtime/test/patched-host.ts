import * as sdk from "@earendil-works/pi-coding-agent";

// 显式运行 patched-host suite 时缺补丁必须失败，不允许 skip 或伪造 SDK capability。
export function requirePatchedHost() {
  if ((sdk as unknown as Record<string, unknown>).THEME_WATCH_CAPABILITY !== "pi.theme-watch.file-version.v1") {
    throw new Error("test:patched-host 需要 host-patches/pi/v1.5.0 的主题补丁 SDK（THEME_WATCH_CAPABILITY=pi.theme-watch.file-version.v1）；请同步安装补丁 CLI/SDK 后在新进程运行。stock SDK 不满足此前提。");
  }
}
