import assert from "node:assert/strict";
import { isolatedConsumer, make, interactive, params, receipt, fauxAssistantMessage, fauxToolCall } from "./harness.mjs";

const entry = await isolatedConsumer(process.env.ASK_I18N);
const f = await make({ entry, cc: process.env.ASK_CC, selection: { tools: ["ask_user_question"] } });
const ui = await interactive(f.runtime);
const session = f.runtime.session;
const displayFailures = [];
function checkDisplay(check) {
  try { check(); } catch (error) { displayFailures.push(error); }
}
try {
  assert.equal(session.extensionRunner.getCommand("languages"), undefined, "installing the optional SDK does not implicitly load its extension or /languages");
  assert.ok(session.getActiveToolNames().includes("ask_user_question"), "Ask needs neither Perf nor a presentation collaborator");
  assert.equal(session.getToolDefinition("ask_user_question").exposure, "model-only");
  const owner = session.getAllTools().find(tool => tool.name === "ask_user_question").sourceInfo.path;
  assert.equal(owner, entry, "compiled CC decorates presentation, never tool ownership");
  const execute = session.getToolDefinition("ask_user_question").execute;
  assert.equal(session.extensionRunner.getExtensionPaths().some(path => /pi-perf/.test(path)), false);

  async function question(name, args, act) {
    ui.clear();
    const before = f.requests.length;
    f.respond([fauxAssistantMessage(fauxToolCall("ask_user_question", args), { stopReason: "toolUse" }), fauxAssistantMessage(`DONE_${name}`)]);
    const shown = ui.visible(args.questions[0].question);
    const run = session.prompt(`Run ${name}.`);
    await shown;
    await ui.visible("You are reviewing checkout totals.");
    await ui.visible("discounts appear");
    await ui.visible("Type something.");
    await act();
    await run;
    const result = session.messages.filter(message => message.role === "toolResult").at(-1);
    assert.ok(result && !result.isError, JSON.stringify(result));
    assert.equal(result.details.error, undefined);
    assert.equal(session.getLastAssistantText(), `DONE_${name}`);
    assert.equal(f.requests.length - before, 2, "CC and Ask never create an extra provider request");
    assert.ok(f.requests[before].tools.includes("ask_user_question"));
    assert.deepEqual(f.requests.at(-1).messages.filter(message => message.role === "toolResult").at(-1).content, result.content, "the genuine model-facing receipt reaches the provider unchanged");
    assert.equal(session.getToolDefinition("ask_user_question").execute, execute);
    f.assertComplete();
    return result;
  }

  const answer = await question("option", params, async () => {
    await ui.visible("Chat about this"); await ui.visible("Explain More");
    await ui.send("\r");
  });
  assert.equal(answer.details.answers[0].answer, "Live");
  assert.match(receipt(f.runtime, answer, params), /Live/);

  const chat = await question("chat", params, async () => {
    await ui.send("\u001b[B", "\u001b[B", "\u001b[B", "\r");
  });
  assert.equal(chat.details.chat.question, params.questions[0].question);
  assert.equal(chat.details.explain, undefined);
  assert.match(chat.content[0].text, /chat/i);
  const chatReceipt = receipt(f.runtime, chat, params);
  checkDisplay(() => assert.match(chatReceipt, /chat/i, "the compact receipt cannot turn a discussion request into no answer"));
  checkDisplay(() => assert.ok(chatReceipt.includes(params.questions[0].question), `Chat receipt lost its question: ${chatReceipt}`));

  const explain = await question("explain", params, async () => {
    await ui.send("\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\r");
    await ui.visible("What would you like explained?");
    await ui.send("Why live?", "\r");
  });
  assert.equal(explain.details.explain.notes, "Why live?");
  assert.equal(explain.details.chat, undefined);
  const explainReceipt = receipt(f.runtime, explain, params);
  checkDisplay(() => assert.match(explainReceipt, /explain/i));
  checkDisplay(() => assert.ok(explainReceipt.includes("Why live?"), `receipt lost explanation notes: ${explainReceipt}`));

  const multi = { context: params.context, questions: [
    { question: "Which checkout surfaces need updates?", header: "Surfaces", multiSelect: true,
      options: [{ label: "Cart", description: "Update the cart." }, { label: "Checkout", description: "Update checkout." }] },
    { question: "When should receipts be sent?", header: "Receipt", options: params.questions[0].options },
  ] };
  const combined = await question("multi-custom-note-unanswered", multi, async () => {
    await ui.send("1", "2", "n", "Keep discount detail.", "\r", "3", "Also order history", "\r");
    await ui.visible(multi.questions[1].question);
    await ui.send("\t");
    await ui.visible("Submit answers");
    await ui.send("n", "Do not change tax.", "\r", "\r");
  });
  const picked = combined.details.answers.find(answer => answer.questionIndex === 0);
  assert.equal(picked.kind, "multi");
  assert.deepEqual(picked.selected, ["Cart", "Checkout"]);
  assert.equal(picked.answer, "Also order history");
  assert.equal(picked.notes, "Keep discount detail.");
  assert.equal(combined.details.globalNote, "Do not change tax.");
  assert.equal(combined.details.answers.some(answer => answer.questionIndex === 1), false);
  assert.match(combined.content[0].text, /not answered|unanswered|not decided/i);
  for (const expanded of [false, true]) {
    const rendered = receipt(f.runtime, combined, multi, expanded);
    for (const expected of ["Surfaces", "Receipt", "Cart", "Checkout", "Also order history", "Keep discount detail.", "Do not change tax."]) {
      checkDisplay(() => assert.ok(rendered.includes(expected), `${expanded ? "expanded" : "compact"} real renderer lost ${expected}: ${rendered}`));
    }
    checkDisplay(() => assert.match(rendered, /not answered|unanswered/i, "an unanswered question remains distinct from a declined questionnaire"));
  }
  assert.deepEqual(f.errors, []);
  if (displayFailures.length) throw new AggregateError(displayFailures, "Real Ask receipt lost questionnaire information");
  console.log("ASK_INTEGRATION_OK questionnaire, Chat, Explain, mixed answers and native receipts");
} finally {
  ui.view.stop();
  await f.runtime.dispose();
}
