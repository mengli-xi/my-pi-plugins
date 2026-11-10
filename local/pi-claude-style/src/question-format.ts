import type { CapturedResult } from "./types.ts";

interface QuestionArgument {
  question: string;
  header?: string;
}

interface QuestionAnswer {
  questionIndex: number;
  question?: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
}

interface QuestionnaireDetails {
  answers: QuestionAnswer[];
  cancelled: boolean;
  globalNote?: string;
  unanswered?: number[];
  chat?: QuestionControlRequest;
  explain?: QuestionControlRequest;
}

interface QuestionControlRequest {
  questionIndex: number;
  question?: string;
  notes?: string;
}

export interface QuestionDisplay {
  state: "running" | "answered" | "chat" | "explain" | "declined" | "cancelled" | "failed";
  title: string;
  rows: QuestionDisplayRow[];
}

export type QuestionDisplayRow =
  | { kind: "answer"; title: string; answer: string }
  | { kind: "note"; text: string }
  | { kind: "text"; text: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function questionArguments(args: unknown): QuestionArgument[] {
  const source = record(args);
  if (!Array.isArray(source?.questions)) return [];
  return source.questions.flatMap((candidate) => {
    const item = record(candidate);
    return typeof item?.question === "string" && item.question
      ? [{
          question: item.question,
          ...(typeof item.header === "string" && item.header.trim()
            ? { header: item.header.trim() }
            : {}),
        }]
      : [];
  });
}

function isQuestionAnswer(value: unknown): value is QuestionAnswer {
  const answer = record(value);
  return Boolean(
    answer &&
    Number.isInteger(answer.questionIndex) &&
    (answer.kind === "option" ||
      answer.kind === "custom" ||
      answer.kind === "multi") &&
    (answer.answer === null || typeof answer.answer === "string") &&
    (answer.question === undefined || typeof answer.question === "string") &&
    (answer.selected === undefined ||
      (Array.isArray(answer.selected) &&
        answer.selected.every((item) => typeof item === "string"))) &&
    (answer.notes === undefined || typeof answer.notes === "string"),
  );
}

function questionnaireDetails(value: unknown): QuestionnaireDetails | undefined {
  const details = record(value);
  const parseControl = (candidate: unknown): QuestionControlRequest | undefined => {
    if (candidate === undefined) return undefined;
    const item = record(candidate);
    if (
      !item ||
      !Number.isInteger(item.questionIndex) ||
      (item.question !== undefined && typeof item.question !== "string") ||
      (item.notes !== undefined && typeof item.notes !== "string")
    ) return undefined;
    return {
      questionIndex: item.questionIndex as number,
      ...(typeof item.question === "string" ? { question: item.question } : {}),
      ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
    };
  };
  const chat = parseControl(details?.chat);
  const explain = parseControl(details?.explain);
  if (
    !details ||
    !Array.isArray(details.answers) ||
    !details.answers.every(isQuestionAnswer) ||
    typeof details.cancelled !== "boolean" ||
    (details.globalNote !== undefined && typeof details.globalNote !== "string") ||
    (details.unanswered !== undefined &&
      (!Array.isArray(details.unanswered) ||
        !details.unanswered.every((index) => Number.isInteger(index) && index >= 0))) ||
    (details.chat !== undefined && !chat) ||
    (details.explain !== undefined && !explain) ||
    (details.chat !== undefined && details.explain !== undefined)
  ) {
    return undefined;
  }
  return {
    answers: details.answers,
    cancelled: details.cancelled,
    ...(typeof details.globalNote === "string" ? { globalNote: details.globalNote } : {}),
    ...(Array.isArray(details.unanswered) ? { unanswered: details.unanswered } : {}),
    ...(chat ? { chat } : {}),
    ...(explain ? { explain } : {}),
  };
}

function answerText(answer: QuestionAnswer): string {
  if (answer.kind === "multi") {
    return [answer.selected?.filter(Boolean).join(", "), answer.answer?.trim()]
      .filter(Boolean).join(", ") || "No selection";
  }
  return answer.answer?.trim() || "No answer";
}

function conciseError(text: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  return first.length > 180 ? `${first.slice(0, 179)}…` : first;
}

export function formatQuestionDisplay(
  args: unknown,
  result?: CapturedResult,
): QuestionDisplay {
  if (!result) {
    return {
      state: "running",
      title: "Waiting for answers…",
      rows: [],
    };
  }
  const detailsError = record(result.details)?.error;
  const errorCode = typeof detailsError === "string" ? detailsError.trim() : "";
  if (result.isError || errorCode) {
    const error = conciseError(errorCode || result.text);
    return {
      state: "failed",
      title: "Questionnaire failed",
      rows: error ? [{ kind: "text", text: `  ⎿ ${error}` }] : [],
    };
  }

  const details = questionnaireDetails(result.details);
  if (!details) {
    return {
      state: "answered",
      title: "Questionnaire completed",
      rows: [],
    };
  }

  const questions = questionArguments(args);
  const ordered = [...details.answers].sort(
    (left, right) => left.questionIndex - right.questionIndex,
  );
  const rows = ordered.flatMap((answer) => {
    const argument = questions[answer.questionIndex];
    const title =
      argument?.header ??
      argument?.question ??
      answer.question ??
      `Question ${answer.questionIndex + 1}`;
    const output: QuestionDisplayRow[] = [{
      kind: "answer",
      title,
      answer: answerText(answer),
    }];
    if (answer.notes?.trim()) {
      output.push({ kind: "note", text: answer.notes.trim() });
    }
    return output;
  });

  if (details.unanswered?.length) {
    const unanswered = details.unanswered.map((index) => {
      const question = questions[index];
      const label = question?.header ?? question?.question;
      return `Question ${index + 1}${label ? ` (${label})` : ""}`;
    });
    rows.push({ kind: "text", text: `  ⎿ Unanswered: ${unanswered.join(", ")}` });
  }
  if (details.globalNote?.trim()) {
    rows.push({ kind: "text", text: `  ⎿ Global note: ${details.globalNote.trim()}` });
  }

  const control = details.explain
    ? { state: "explain" as const, title: "Explain More:", request: details.explain }
    : details.chat
      ? { state: "chat" as const, title: "Chat about this:", request: details.chat }
      : undefined;
  if (control) {
    const question =
      questions[control.request.questionIndex]?.question ??
      control.request.question ??
      `Question ${control.request.questionIndex + 1}`;
    const controlRows: QuestionDisplayRow[] = [{ kind: "text", text: `  ⎿ ${question}` }];
    if (control.request.notes?.trim()) {
      controlRows.push({ kind: "note", text: control.request.notes.trim() });
    }
    return {
      state: control.state,
      title: control.title,
      rows: [...rows, ...controlRows],
    };
  }

  if (details.cancelled && ordered.length === 0) {
    return {
      state: "declined",
      title: "User declined the questions",
      rows,
    };
  }
  if (details.cancelled) {
    return {
      state: "cancelled",
      title: "User answered Agent's questions: · cancelled",
      rows,
    };
  }
  return {
    state: "answered",
    title: "User answered Agent's questions:",
    rows,
  };
}
