import type { GitFileState } from "@coilcoil/runtime-protocol";

const STATE_LETTER: Record<GitFileState, string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", "type-changed": "T", untracked: "U", conflicted: "!",
};

const STATE_LABEL: Record<GitFileState, string> = {
  modified: "已修改", added: "新增", deleted: "已删除", renamed: "改名", copied: "复制", "type-changed": "类型变化", untracked: "未跟踪", conflicted: "冲突",
};

export function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  return index < 0 ? { name: path, dir: "" } : { name: path.slice(index + 1), dir: path.slice(0, index) };
}

export function FileRow({ file, state, onOpen, actions, leading }: {
  file: { path: string; originalPath?: string };
  state: GitFileState;
  onOpen: () => void;
  actions?: React.ReactNode;
  /** 画在最左边的东西：历史里是接着往下的图线。 */
  leading?: React.ReactNode;
}): React.JSX.Element {
  const { name, dir } = splitPath(file.path);
  return (
    <li className={`git-file state-${state}`}>
      {leading}
      <button className="git-file-open" type="button" onClick={onOpen} title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}>
        <span className="git-file-name">{name}</span>
        {dir ? <span className="git-file-dir">{dir}</span> : null}
      </button>
      <span className="git-file-actions">{actions}</span>
      <span className="git-file-state" title={STATE_LABEL[state]}>{STATE_LETTER[state]}</span>
    </li>
  );
}
