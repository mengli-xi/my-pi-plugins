import type { PackageSource } from "@earendil-works/pi-coding-agent";

export type PackageScope = "global" | "project";
export type PackageKind = "npm" | "git" | "local";

export interface PackageLocator {
  scope: PackageScope;
  index: number;
  source: string;
}

export interface ConfiguredPackageEntry extends PackageLocator {
  raw: PackageSource;
  enabled: boolean;
  filtered: boolean;
  installedPath?: string;
}

export interface PackageManifestInfo {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  resourceCounts: Partial<Record<"extensions" | "skills" | "prompts" | "themes", number>>;
}

export interface ManagedPackage {
  id: string;
  source: string;
  displayName: string;
  kind: PackageKind;
  enabled: boolean;
  missing: boolean;
  protected: boolean;
  entries: ConfiguredPackageEntry[];
  installedPath?: string;
  manifest: PackageManifestInfo;
}

export interface PackageViewState {
  filter: "all" | "enabled" | "disabled" | "updates";
  query: string;
  selectedId?: string;
}

export type ManagerAction =
  | { type: "close" }
  | { type: "toggle"; packageId: string }
  | { type: "check" }
  | { type: "update"; packageId: string }
  | { type: "reload" };
