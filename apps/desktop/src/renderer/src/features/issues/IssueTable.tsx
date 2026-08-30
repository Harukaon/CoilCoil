import { ChevronDown, ChevronUp, CornerDownRight } from "lucide-react";
import type { Issue } from "../../../../shared/desktop-api";
import { ISSUE_TIME_FORMAT } from "./IssueTimeline";
import {
  ISSUE_PRIORITY_NAME,
  ISSUE_STATUS_NAME,
  childrenOf,
  withChildrenInline,
  type IssueSortKey,
} from "./issueModel";

const COLUMNS: { key: IssueSortKey; name: string; align?: "right" }[] = [
  { key: "priority", name: "优先级" },
  { key: "title", name: "任务" },
  { key: "status", name: "状态" },
  { key: "createdAt", name: "提出" },
  { key: "updatedAt", name: "最近动静", align: "right" },
];

/**
 * 表格视图。
 *
 * 看板一列只放得下十来张卡，条目一多就得来回滚；表格是一行一条，一屏能扫完，
 * 而且能按任意一列排。两种视图看的是同一份数据，只是密度不同。
 *
 * 子任务紧跟在父后面缩进一格——按排序键硬排会把父子拆散到两处，看不出从属关系。
 */
export function IssueTable({
  issues,
  runningId,
  sortKey,
  ascending,
  onSort,
  onOpen,
}: {
  issues: Issue[];
  runningId?: string;
  sortKey: IssueSortKey;
  ascending: boolean;
  onSort(key: IssueSortKey): void;
  onOpen(id: string): void;
}): React.JSX.Element {
  const rows = withChildrenInline(issues, sortKey, ascending);
  if (!rows.length) return <p className="issue-table-empty">这里还没有任务。</p>;
  return (
    <div className="issue-table-scroll">
      <table className="issue-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.key} className={column.align === "right" ? "right" : ""}>
                <button type="button" onClick={() => onSort(column.key)}>
                  {column.name}
                  {sortKey === column.key ? (ascending ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ issue, child }) => {
            const children = childrenOf(issues, issue.id);
            return (
              <tr
                key={issue.id}
                className={issue.id === runningId ? "active" : ""}
                tabIndex={0}
                onClick={() => onOpen(issue.id)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(issue.id); } }}
              >
                <td><span className={`issue-priority ${issue.priority}`}>{ISSUE_PRIORITY_NAME[issue.priority]}</span></td>
                <td className="issue-table-title">
                  {/* 内容包一层再 flex：直接把 td 变成 flex 容器会让它退出表格的列宽计算。 */}
                  <span className="issue-table-title-inner">
                    {child ? <CornerDownRight size={11} /> : null}
                    <span className="issue-table-name">{issue.title}</span>
                    {issue.deferred ? <span className="issue-tag defer">以后再看</span> : null}
                    {children.length ? <span className="issue-tag">{children.length} 条子任务</span> : null}
                    {issue.events.length ? <small>{issue.events.length} 条记录</small> : null}
                  </span>
                </td>
                <td>{ISSUE_STATUS_NAME[issue.status]}</td>
                <td>{ISSUE_TIME_FORMAT.format(new Date(issue.createdAt))}</td>
                <td className="right">{ISSUE_TIME_FORMAT.format(new Date(issue.updatedAt))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
