import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

type SpeechInputState = 'idle' | 'listening' | 'error' | 'unsupported';
type SpeechRecognitionAlternative = { transcript?: string };
type SpeechRecognitionResult = {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative | undefined;
};
type SpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
};
type SpeechRecognitionErrorEvent = {
  error?: string;
};
type SpeechRecognitionController = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionController;
type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

type UseTalkSpeechInputInput = {
  draft: string;
  maxChars: number;
  textareaRef: RefObject<HTMLTextAreaElement>;
  handleDraftChange: (value: string) => void;
};

export type TalkSpeechInputController = {
  speechSupported: boolean;
  speechListening: boolean;
  speechError: string | null;
  handleToggleSpeechInput: () => void;
};

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as SpeechWindow;
  return (
    speechWindow.SpeechRecognition ??
    speechWindow.webkitSpeechRecognition ??
    null
  );
}

function describeSpeechRecognitionError(error?: string): string {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission denied.';
    case 'no-speech':
      return 'No speech detected.';
    case 'audio-capture':
      return 'Microphone unavailable.';
    case 'network':
      return 'Speech recognition network error.';
    default:
      return 'Speech input stopped.';
  }
}

export function useTalkSpeechInput({
  draft,
  maxChars,
  textareaRef,
  handleDraftChange,
}: UseTalkSpeechInputInput): TalkSpeechInputController {
  const recognitionRef = useRef<SpeechRecognitionController | null>(null);
  const draftRef = useRef(draft);
  const [speechState, setSpeechState] =
    useState<SpeechInputState>('unsupported');
  const [speechError, setSpeechError] = useState<string | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setSpeechState(getSpeechRecognitionConstructor() ? 'idle' : 'unsupported');
  }, []);

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  const appendTranscript = useCallback(
    (transcript: string) => {
      const normalizedTranscript = transcript.replace(/\s+/g, ' ').trim();
      if (!normalizedTranscript) return;

      const currentDraft = draftRef.current;
      const textarea = textareaRef.current;
      const cursor = textarea?.selectionStart ?? currentDraft.length;
      const before = currentDraft.slice(0, cursor);
      const after = currentDraft.slice(cursor);
      const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
      const suffix = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
      const insertedText = `${prefix}${normalizedTranscript}${suffix}`;
      const nextDraft = `${before}${insertedText}${after}`.slice(0, maxChars);
      const nextCursor = Math.min(
        before.length + insertedText.length,
        nextDraft.length,
      );

      handleDraftChange(nextDraft);
      requestAnimationFrame(() => {
        const currentTextarea = textareaRef.current;
        if (!currentTextarea) return;
        currentTextarea.focus();
        currentTextarea.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [handleDraftChange, maxChars, textareaRef],
  );

  const speechListening = speechState === 'listening';

  const handleToggleSpeechInput = useCallback(() => {
    if (speechListening) {
      recognitionRef.current?.stop();
      setSpeechState('idle');
      return;
    }

    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      setSpeechState('unsupported');
      setSpeechError(null);
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = window.navigator.language || 'en-US';
    recognition.onstart = () => {
      setSpeechState('listening');
      setSpeechError(null);
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
        setSpeechState((current) =>
          current === 'listening' ? 'idle' : current,
        );
      }
    };
    recognition.onerror = (event) => {
      setSpeechError(describeSpeechRecognitionError(event.error));
      setSpeechState('error');
    };
    recognition.onresult = (event) => {
      let finalTranscript = '';
      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript;
        if (result?.isFinal && transcript) {
          finalTranscript += ` ${transcript}`;
        }
      }
      appendTranscript(finalTranscript);
    };

    try {
      recognition.start();
      setSpeechState('listening');
      setSpeechError(null);
    } catch (error) {
      recognitionRef.current = null;
      setSpeechError(
        error instanceof Error ? error.message : 'Unable to start voice input.',
      );
      setSpeechState('error');
    }
  }, [appendTranscript, speechListening]);

  return {
    speechSupported: speechState !== 'unsupported',
    speechListening,
    speechError,
    handleToggleSpeechInput,
  };
}
