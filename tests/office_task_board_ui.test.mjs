import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appJs = readFileSync(new URL("../web/office/app.js", import.meta.url), "utf8");
const stylesCss = readFileSync(new URL("../web/office/styles.css", import.meta.url), "utf8");

test("Agent Office task board exposes Kanban drop lanes and manual agent assignment controls", () => {
  assert.match(appJs, /data-task-board-column/);
  assert.match(appJs, /data-task-board-drag/);
  assert.match(appJs, /data-task-board-assignee/);
  assert.match(appJs, /taskBoardHandleDrop/);
});

test("Agent Office task cards use agent sprite identifiers and unlockable feedback editing", () => {
  assert.match(appJs, /taskBoardAgentBadgeHtml/);
  assert.match(appJs, /data-task-board-unlock/);
  assert.match(appJs, /task-board-card__agent/);
});

test("Agent Office task board CSS supports responsive horizontal Kanban lanes", () => {
  assert.match(stylesCss, /\.task-board-columns/);
  assert.match(stylesCss, /grid-auto-flow:\s*column/);
  assert.match(stylesCss, /minmax\(260px,\s*1fr\)/);
  assert.match(stylesCss, /\.task-agent-sprite/);
});
