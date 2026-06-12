import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  getContextSourceContentUrl,
  uploadTalkContextSource,
  UnauthorizedError,
  type ContextSource,
} from '../lib/api';
import { isRasterizablePdf, renderAndUploadPdfPages } from '../lib/pdf-raster';

export const TALK_CONTEXT_SOURCE_MAX_FILE_SIZE = 10 * 1024 * 1024;
export const TALK_CONTEXT_SOURCE_ALLOWED_FILE_EXTENSIONS =
  '.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.html,.json,.xml,.yaml,.yml,.py,.js,.ts,.jsx,.tsx,.java,.c,.h,.cpp,.hpp,.go,.rs,.sh,.sql,.rtf,.rb,.php,.swift,.kt,.lua,.r,.toml,.ini,.cfg,.log';

export type ContextSourceRenderState =
  | { phase: 'rendering'; done: number; total: number }
  | { phase: 'done'; total: number }
  | { phase: 'failed' };

export type UploadingContextSourceFile = {
  localId: string;
  fileName: string;
  status: 'uploading' | 'done' | 'error';
  error?: string;
};

export type TalkContextSourceUploadController = {
  uploadingFiles: UploadingContextSourceFile[];
  renderStates: Record<string, ContextSourceRenderState>;
  handleFilesSelected: (files: FileList | File[]) => Promise<void>;
  handleRetryRender: (sourceId: string) => void;
};

export function useTalkContextSourceUpload({
  talkId,
  setSources,
  onUnauthorized,
}: {
  talkId: string;
  setSources: Dispatch<SetStateAction<ContextSource[]>>;
  onUnauthorized: () => void;
}): TalkContextSourceUploadController {
  const [uploadingFiles, setUploadingFiles] = useState<
    UploadingContextSourceFile[]
  >([]);
  const [renderStates, setRenderStates] = useState<
    Record<string, ContextSourceRenderState>
  >({});

  useEffect(() => {
    setUploadingFiles([]);
    setRenderStates({});
  }, [talkId]);

  const rasterizePdfSource = useCallback(
    async (
      sourceId: string,
      loadBytes: () => Promise<ArrayBuffer>,
    ): Promise<void> => {
      setRenderStates((prev) => ({
        ...prev,
        [sourceId]: { phase: 'rendering', done: 0, total: 0 },
      }));
      try {
        const data = await loadBytes();
        const result = await renderAndUploadPdfPages({
          talkId,
          sourceId,
          data,
          onProgress: (done, total) =>
            setRenderStates((prev) => ({
              ...prev,
              [sourceId]: { phase: 'rendering', done, total },
            })),
        });
        setRenderStates((prev) => ({
          ...prev,
          [sourceId]:
            result.pagesTotal > 0
              ? { phase: 'done', total: result.pagesTotal }
              : { phase: 'failed' },
        }));
      } catch {
        setRenderStates((prev) => ({
          ...prev,
          [sourceId]: { phase: 'failed' },
        }));
      }
    },
    [talkId],
  );

  const handleRetryRender = useCallback(
    (sourceId: string): void => {
      void rasterizePdfSource(sourceId, () =>
        fetch(getContextSourceContentUrl(talkId, sourceId), {
          credentials: 'include',
        }).then((res) => {
          if (!res.ok) throw new Error(`Failed to load PDF (${res.status})`);
          return res.arrayBuffer();
        }),
      );
    },
    [rasterizePdfSource, talkId],
  );

  const handleFilesSelected = useCallback(
    async (files: FileList | File[]) => {
      const fileArr = Array.from(files);
      if (fileArr.length === 0) return;

      for (const file of fileArr) {
        const localId = `upload_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        if (file.size > TALK_CONTEXT_SOURCE_MAX_FILE_SIZE) {
          setUploadingFiles((prev) => [
            ...prev,
            {
              localId,
              fileName: file.name,
              status: 'error',
              error: 'File exceeds 10 MB limit',
            },
          ]);
          continue;
        }

        setUploadingFiles((prev) => [
          ...prev,
          { localId, fileName: file.name, status: 'uploading' },
        ]);

        try {
          const source = await uploadTalkContextSource(talkId, file);
          setSources((prev) => [...prev, source]);
          setUploadingFiles((prev) =>
            prev.map((f) =>
              f.localId === localId ? { ...f, status: 'done' as const } : f,
            ),
          );
          window.setTimeout(() => {
            setUploadingFiles((prev) =>
              prev.filter((f) => f.localId !== localId),
            );
          }, 1500);
          if (isRasterizablePdf(file.type)) {
            void rasterizePdfSource(source.id, () => file.arrayBuffer());
          }
        } catch (err) {
          if (err instanceof UnauthorizedError) {
            onUnauthorized();
            return;
          }
          setUploadingFiles((prev) =>
            prev.map((f) =>
              f.localId === localId
                ? {
                    ...f,
                    status: 'error' as const,
                    error: err instanceof Error ? err.message : 'Upload failed',
                  }
                : f,
            ),
          );
        }
      }
    },
    [onUnauthorized, rasterizePdfSource, setSources, talkId],
  );

  return {
    uploadingFiles,
    renderStates,
    handleFilesSelected,
    handleRetryRender,
  };
}
