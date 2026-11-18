import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { ApiError } from "../lib/api";
import { VOICE_PLACEHOLDER } from "../lib/capture-content";
import { DetailPageShell, describeDetailError } from "../components/detail";
import {
  CaptureDetailView,
  ReminderDetailView,
  TaskDetailView,
} from "./RecordDetails";
import { captureFixture, reminderFixture, taskFixture } from "../test/fixtures";

function render(node: ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("CaptureDetailView", () => {
  it("renders a speech-to-text transcript with its provenance and separate caption", () => {
    const html = render(
      <CaptureDetailView
        capture={captureFixture({
          isVoice: true,
          rawText: "Call Ada about the launch",
          transcript: "remind me to call Ada about the launch tomorrow",
          transcriptSource: "SPEECH_PROVIDER",
        })}
        timeZone="Africa/Lagos"
      />,
    );

    expect(html).toContain("Speech-to-text transcript");
    expect(html).toContain("Caption");
    expect(html).toContain("Call Ada about the launch");
    expect(html).toContain("remind me to call Ada about the launch tomorrow");
  });

  it("shows a caption-only voice capture as a caption plus an honest transcript state", () => {
    const html = render(
      <CaptureDetailView
        capture={captureFixture({
          isVoice: true,
          rawText: "Call Ada tomorrow",
          transcript: null,
          transcriptSource: null,
        })}
        timeZone="Africa/Lagos"
      />,
    );

    expect(html).toContain("Caption");
    expect(html).toContain("Call Ada tomorrow");
    expect(html).toContain("Transcript unavailable");
    expect(html).not.toContain(VOICE_PLACEHOLDER);
  });

  it("does not render the placeholder for an untranscribed voice capture", () => {
    const html = render(
      <CaptureDetailView
        capture={captureFixture({
          isVoice: true,
          rawText: VOICE_PLACEHOLDER,
          transcript: null,
          transcriptSource: null,
        })}
        timeZone="Africa/Lagos"
      />,
    );

    expect(html).toContain("Transcript unavailable");
    expect(html).not.toContain(VOICE_PLACEHOLDER);
    expect(html).not.toContain("Captured text");
  });

  it("renders only public DTO fields, never adapter metadata or cache fields", () => {
    const captureWithPrivateFields = {
      ...captureFixture({
        isVoice: true,
        rawText: VOICE_PLACEHOLDER,
        transcript: "A safe transcript",
        transcriptSource: "SPEECH_PROVIDER",
      }),
      metadata:
        '{"voice":{"sttProvider":"private-provider","fileId":"private-file"}}',
      mediaRef: "private/audio/path.oga",
      classificationCache: "private-cache-value",
      classificationCacheKey: "private-cache-key",
      sourceRef: "private-source-ref",
    };

    const html = render(
      <CaptureDetailView
        capture={captureWithPrivateFields}
        timeZone="Africa/Lagos"
      />,
    );

    expect(html).toContain("A safe transcript");
    expect(html).not.toContain("private-provider");
    expect(html).not.toContain("private-file");
    expect(html).not.toContain("private/audio/path.oga");
    expect(html).not.toContain("private-cache-value");
    expect(html).not.toContain("private-cache-key");
    expect(html).not.toContain("private-source-ref");
  });
});

describe("task and reminder detail views", () => {
  it("renders the task record that was requested", () => {
    const html = render(
      <TaskDetailView task={taskFixture()} timeZone="Africa/Lagos" />,
    );
    expect(html).toContain("Call Ada");
    expect(html).toContain("Ask about the launch date");
    expect(html).toContain("HIGH");
  });

  it("renders the reminder record that was requested", () => {
    const html = render(
      <ReminderDetailView
        reminder={reminderFixture()}
        timeZone="Africa/Lagos"
      />,
    );
    expect(html).toContain("Call Ada");
    expect(html).toContain("Ask about the launch date");
    expect(html).toContain("SCHEDULED");
  });
});

describe("detail error states", () => {
  it("maps 401 and 404 without exposing server error text", () => {
    const unauthorized = describeDetailError(
      new ApiError("provider exploded: secret value", "UNAUTHORIZED", 401),
    );
    expect(unauthorized.kind).toBe("unauthorized");
    expect(unauthorized.title).toBe("Sign in required");
    expect(unauthorized.message).not.toContain("provider exploded");
    expect(unauthorized.message).not.toContain("secret value");

    const missing = describeDetailError(
      new ApiError("capture raw text: top secret", "NOT_FOUND", 404),
    );
    expect(missing.kind).toBe("not-found");
    expect(missing.title).toBe("Not Found");
    expect(missing.message).not.toContain("top secret");
  });

  it("uses a record-type specific not-found message", () => {
    const missingTask = describeDetailError(
      new ApiError("boom", "NOT_FOUND", 404),
      "task",
    );
    expect(missingTask.message).toBe(
      "The task you are looking for does not exist.",
    );

    const missingNote = describeDetailError(
      new ApiError("boom", "NOT_FOUND", 404),
      "note",
    );
    expect(missingNote.message).toBe(
      "The note you are looking for does not exist.",
    );

    const unknownType = describeDetailError(
      new ApiError("boom", "NOT_FOUND", 404),
      "mystery",
    );
    expect(unknownType.message).toBe(
      "The record you are looking for does not exist.",
    );
  });

  it("does not render children when the record could not be loaded", () => {
    const html = render(
      <DetailPageShell
        backTo="/captures"
        backLabel="Quick Capture"
        isLoading={false}
        error={new ApiError("hidden details", "NOT_FOUND", 404)}
      >
        <div>TOP SECRET RECORD CONTENT</div>
      </DetailPageShell>,
    );

    expect(html).toContain("Not Found");
    expect(html).not.toContain("TOP SECRET RECORD CONTENT");
  });
});
