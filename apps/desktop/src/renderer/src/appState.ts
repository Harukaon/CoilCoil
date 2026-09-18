import type { ProjectSelection, ProjectSnapshot } from "@coilcoil/runtime-protocol";

const LEGACY_PROJECT_STORAGE_KEY = "coilcoil.selected-workspace";
export const PROJECTS_STORAGE_KEY = "coilcoil.mounted-projects";
export const ACTIVE_PROJECT_STORAGE_KEY = "coilcoil.active-project";
export const ONBOARDING_STORAGE_KEY = "coilcoil.onboarding";

export const EMPTY_PROJECT: ProjectSnapshot = {
  cwd: "",
  files: [],
  changes: [],
  terminals: [],
  plan: [],
  refreshedAt: 0,
};

function isWorkspace(value: Partial<ProjectSelection>): value is ProjectSelection {
  return typeof value.name === "string"
    && typeof value.path === "string"
    && value.kind === "workspace";
}

export function loadStoredProjects(): ProjectSelection[] {
  try {
    const stored = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Array<Partial<ProjectSelection>>;
      if (Array.isArray(parsed)) return parsed.filter(isWorkspace);
    }
    const legacy = window.localStorage.getItem(LEGACY_PROJECT_STORAGE_KEY);
    if (!legacy) return [];
    const parsed = JSON.parse(legacy) as Partial<ProjectSelection>;
    return isWorkspace(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

/**
 * 挂载清单同时写两处：磁盘上那份是真相，localStorage 只是让下次开机能立刻画出来。
 *
 * 为什么不能只有 localStorage：它是按来源分家的，`npm run dev`（http://localhost）
 * 和安装版（file://）各存各的，在两者之间切一次侧边栏的文件夹就像丢了一样。
 */
export function saveMountedProjects(projects: ProjectSelection[]): void {
  const workspaces = projects
    .filter((item) => item.kind === "workspace")
    .map((item) => ({ name: item.name, path: item.path, kind: "workspace" as const }));
  try {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(workspaces));
  } catch {
    // 存不下就算了，磁盘那份才是真相。
  }
  void window.coilcoil.setMountedProjects?.(workspaces);
}

/**
 * 开机时把磁盘上那份和本地这份合起来：两边都可能是「另一半」，所以取并集，
 * 以本地的顺序打底（那是用户自己拖出来的），磁盘上多出来的接在后面。
 */
export async function syncMountedProjects(): Promise<ProjectSelection[]> {
  const stored = await window.coilcoil.mountedProjects?.().catch(() => []) ?? [];
  // 本地那份直接从 localStorage 现读，避免调用方传进来一份不全的。
  const merged = uniqueProjects([...loadStoredProjects(), ...stored.filter(isWorkspace)]);
  saveMountedProjects(merged);
  return merged;
}

export function uniqueProjects(projects: ProjectSelection[]): ProjectSelection[] {
  const seen = new Set<string>();
  return projects.filter((project) => {
    if (seen.has(project.path)) return false;
    seen.add(project.path);
    return true;
  });
}

/**
 * 引导走完没有，以及用户当时对系统权限的选择。
 *
 * 只记「走完了」和「选了什么」，不记走到第几步：引导很短，中途退出下次从头来比
 * 记一个可能已经过期的进度更不容易出错。设置里可以随时重来。
 */
export interface OnboardingRecord {
  completedAt: string;
  /** 每一项系统权限当时选了给还是不给。 */
  permissions?: Record<string, "grant" | "skip">;
}

export function loadOnboarding(): OnboardingRecord | undefined {
  try {
    const stored = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!stored) return undefined;
    const parsed = JSON.parse(stored) as Partial<OnboardingRecord>;
    return typeof parsed?.completedAt === "string" ? parsed as OnboardingRecord : undefined;
  } catch {
    // 读不出来就当没走过：再走一遍引导，比把用户挡在外面强。
    return undefined;
  }
}

export function saveOnboarding(record: OnboardingRecord): void {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // 写不进去也要让用户进得去，大不了下次再引导一遍。
  }
}

export function clearOnboarding(): void {
  try {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // 同上。
  }
}
