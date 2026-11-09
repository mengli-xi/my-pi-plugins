import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { installWidgetSpacing, PROBES } from "../src/host/widget-spacing.ts";

const prototype = InteractiveMode.prototype as unknown as {
  renderWidgetContainer(container: Container, widgets: Map<string, Text>, empty: boolean, leading: boolean): void;
};

test("only the populated above-editor spacer changes, across multiple view owners and teardown", () => {
  const native = prototype.renderWidgetContainer;
  assert.equal(PROBES[0]!.check!(), true);
  const releaseMain = installWidgetSpacing();
  const releaseChild = installWidgetSpacing();
  const widget = new Text("todo", 0, 0);
  const widgets = new Map([["todo", widget]]);
  const container = new Container();
  try {
    for (const receiver of [{ view: "main" }, { view: "side" }, { view: "subagent" }]) {
      prototype.renderWidgetContainer.call(receiver, container, widgets, true, true);
      assert.deepEqual(container.children, [widget]);
      assert.deepEqual(container.render(20).map(line => line.trimEnd()), ["todo"]);
    }
    prototype.renderWidgetContainer(container, widgets, false, false);
    assert.deepEqual(container.children, [widget], "below-editor widgets keep their identity");
    prototype.renderWidgetContainer(container, new Map(), true, true);
    assert.deepEqual(container.render(20).map(line => line.trimEnd()), [""], "native empty spacer is preserved");
    releaseMain();
    assert.notEqual(prototype.renderWidgetContainer, native, "child still owns the patch");
    releaseChild();
    assert.equal(prototype.renderWidgetContainer, native);
    prototype.renderWidgetContainer(container, widgets, true, true);
    assert.deepEqual(container.render(20).map(line => line.trimEnd()), ["", "todo"]);
  } finally { releaseMain(); releaseChild(); }
});

test("a changed native widget builder is left untouched and keeps its original spacing", () => {
  const native = prototype.renderWidgetContainer;
  const changed = function (this: unknown, container: Container, widgets: Map<string, Text>, empty: boolean, leading: boolean) {
    native.call(this, container, widgets, empty, leading);
    container.addChild(new Text("new host behaviour", 0, 0));
  };
  prototype.renderWidgetContainer = changed;
  try {
    assert.equal(PROBES[0]!.check!(), false);
    const release = installWidgetSpacing();
    assert.equal(prototype.renderWidgetContainer, changed);
    const container = new Container();
    prototype.renderWidgetContainer(container, new Map([["todo", new Text("todo", 0, 0)]]), true, true);
    assert.deepEqual(container.render(30).map(line => line.trimEnd()), ["", "todo", "new host behaviour"]);
    release();
    assert.equal(prototype.renderWidgetContainer, changed);
  } finally { prototype.renderWidgetContainer = native; }
});
