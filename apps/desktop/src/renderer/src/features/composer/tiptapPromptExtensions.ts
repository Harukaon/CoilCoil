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

  addAttributes() {
    return {
      id: { default: "" },
      label: { default: "" },
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
      },
      node.attrs.label as string,
    ];
  },
});
