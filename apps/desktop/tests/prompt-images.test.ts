import assert from "node:assert/strict";
import test from "node:test";
import { appendPromptImages, MAX_PROMPT_IMAGES } from "../src/renderer/src/features/composer/promptImages";

const image = (id: string) => ({ id, mimeType: "image/png", data: "abc" });

test("prompt 图片数量达到上限时拒绝继续添加", () => {
  const current = Array.from({ length: MAX_PROMPT_IMAGES }, (_, index) => image(`current-${index}`));
  assert.throws(() => appendPromptImages(current, [image("next")]), /最多只能附加/);
  assert.equal(appendPromptImages(current.slice(0, -1), [image("next")]).length, MAX_PROMPT_IMAGES);
});
