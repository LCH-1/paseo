import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { userEvent } from "@vitest/browser/context";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type { PendingPermission } from "@/types/shared";
import { QuestionFormCard } from "./question-form-card";

// Load translations so controls expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * A real browser with the real web `EditingTextInput`, because the bug under test lives in the
 * gap between that input and React state: the input owns its text and never replays state, so a
 * card that drops the Other text from state alone keeps showing it while submit ignores it.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function buildPermission(question: Record<string, unknown>): PendingPermission {
  return {
    key: "perm-1",
    agentId: "agent-1",
    request: {
      id: "perm-1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: [question] },
    },
  };
}

function mountCard(question: Record<string, unknown>) {
  const onRespond = vi.fn<(response: AgentPermissionResponse) => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QuestionFormCard
        permission={buildPermission(question)}
        onRespond={onRespond}
        isResponding={false}
        responseError={null}
      />,
    ),
  );
  mounted.push({ root, container });

  const view = within(container);
  const optionRole = question.multiSelect ? "checkbox" : "radio";
  const otherInput = () =>
    view.getByRole<HTMLInputElement>("textbox", { name: String(question.question) });
  const check = (label: string) => act(() => view.getByRole(optionRole, { name: label }).click());
  const type = (text: string) => {
    const input = otherInput();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("HTML input value setter is unavailable");
    act(() => {
      valueSetter.call(input, text);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    });
  };
  const submit = () => act(() => view.getByRole("button", { name: "Submit" }).click());
  const submittedAnswers = (): Record<string, string> => {
    const response = onRespond.mock.calls[0]?.[0];
    if (!response || response.behavior !== "allow") throw new Error("card did not submit");
    return (response.updatedInput as { answers: Record<string, string> }).answers;
  };
  return { check, type, otherInput, submit, submittedAnswers, container, onRespond };
}

const multiSelectQuestion = {
  question: "Which fruits do you like?",
  header: "Fruits",
  options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
  multiSelect: true,
  allowOther: true,
};

const singleSelectQuestion = {
  question: "Which provider?",
  header: "Provider",
  options: [{ label: "Claude Code" }, { label: "Codex" }],
  multiSelect: false,
  allowOther: true,
};

describe("QuestionFormCard other answers", () => {
  it("selects and copies Korean instructions and a URL inside an unselectable panel", async () => {
    const question = "로그인 안내: https://example.test/callback?code=123&state=abc";
    const card = mountCard({ question, header: "Login", options: [] });
    card.container.style.userSelect = "none";
    card.container.style.width = "900px";
    card.container.style.maxWidth = "100%";
    const instruction = within(card.container).getByTestId("question-form-current-question");
    const pasteTarget = document.createElement("textarea");
    pasteTarget.setAttribute("aria-label", "Clipboard verification");
    pasteTarget.style.color = "transparent";
    pasteTarget.style.caretColor = "transparent";
    card.container.appendChild(pasteTarget);
    let trustedCopy = false;
    let trustedPaste = false;
    card.container.addEventListener("copy", (event) => {
      trustedCopy = event.isTrusted;
    });
    pasteTarget.addEventListener("paste", (event) => {
      trustedPaste = event.isTrusted;
    });

    await userEvent.tripleClick(instruction, { position: { x: 4, y: 11 } });
    await expect.poll(() => window.getSelection()?.toString() === question).toBe(true);
    await userEvent.copy();
    expect(trustedCopy).toBe(true);
    await userEvent.click(pasteTarget);
    await userEvent.paste();

    expect(trustedPaste).toBe(true);
    await expect.poll(() => pasteTarget.value === question).toBe(true);
    expect(card.onRespond).not.toHaveBeenCalled();
  });

  it("keeps checked options when the other answer is typed afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.check("Apple");
    card.check("Cherry");
    card.type("durian");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Cherry, durian" });
  });

  it("keeps the typed other answer when options are checked afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.type("durian");
    card.check("Apple");
    card.check("Banana");

    expect(card.otherInput().value).toBe("durian");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Banana, durian" });
  });

  it("replaces the selected option with the typed other answer (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.check("Codex");
    card.type("OpenCode");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Provider: "OpenCode" });
  });

  it("clears the typed other answer on screen when an option is picked afterwards (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.type("OpenCode");
    card.check("Codex");

    expect(card.otherInput().value).toBe("");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Provider: "Codex" });
  });
});
