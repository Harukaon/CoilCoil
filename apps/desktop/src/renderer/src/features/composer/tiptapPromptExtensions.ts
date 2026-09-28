import { Node } from "@tiptap/core";
import { BROWSER_ELEMENT_NODE } from "./tiptapPromptDocument";

/**
 * browser-element pill 的 inline atom 节点。
 *
 * atom + selectable：Backspace 一次整个删掉，不用手写 keydown。
 * inline 而不是 inline-flex 渲染：pill 前后文本的 baseline 对齐一致，
 * 光标在 pill 附近不再上下跳。外观仍走 .prompt-editor-element 的胶囊样式。
 */
export const BrowserElementNode = Node.create({
  name: BROWSER_ELEMENT_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  // 编号和名字要能从网页结构里读回来：复制、剪切后粘贴时，编辑器是按网页结构重新读一遍的。
  // 以前读不回来，粘贴出来的元素是空的，输入框就当它不存在了。
  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-prompt-element-id") ?? "",
        renderHTML: () => ({}),
      },
      label: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-prompt-element-label") ?? element.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-prompt-element-id]` }];
  },

  renderHTML({ node }) {
    return [
      "span",
      {
        class: "prompt-editor-element",
        "data-prompt-element-id": node.attrs.id,
        "data-prompt-element-label": node.attrs.label,
      },
      node.attrs.label as string,
    ];
  },
});
