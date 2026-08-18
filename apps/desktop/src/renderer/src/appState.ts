import type { ProjectSelection, ProjectSnapshot } from "@suocode/runtime-protocol";

const LEGACY_PROJECT_STORAGE_KEY = "suocode.selected-workspace";
export const PROJECTS_STORAGE_KEY = "suocode.mounted-projects";
export const ACTIVE_PROJECT_STORAGE_KEY = "suocode.active-project";

export const AGENT_ACTIVITY_PHRASES = [
  "工作中…",
  "整理线索…",
  "翻找文件…",
  "冲浪中…",
  "组织思路…",
  "沿着思路前进…",
  "快收尾了…",
];

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

export function uniqueProjects(projects: ProjectSelection[]): ProjectSelection[] {
  const seen = new Set<string>();
  return projects.filter((project) => {
    if (seen.has(project.path)) return false;
    seen.add(project.path);
    return true;
  });
}
