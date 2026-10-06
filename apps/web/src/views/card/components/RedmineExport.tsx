import { t } from "@lingui/core/macro";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RouterInputs, RouterOutputs } from "@kan/api";
import { generateUID } from "@kan/shared/utils";

import Button from "~/components/Button";
import CheckboxDropdown from "~/components/CheckboxDropdown";
import Input from "~/components/Input";
import { api } from "~/utils/api";

function useBotRequest(cardPublicId: string) {
  const [id, setId] = useState("");
  const generation = useRef(0);
  const [initial, setInitial] =
    useState<RouterOutputs["taskControl"]["redmineRequest"]>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const mutation = api.taskControl.redmineRequest.useMutation();
  const status = api.taskControl.redmineRequestStatus.useQuery(
    { cardPublicId, request_id: id || "000000000000" },
    {
      enabled: !!id,
      retry: false,
      refetchInterval: (query) =>
        ["queued", "leased"].includes(query.state.data?.state ?? "queued")
          ? 2000
          : false,
    },
  );
  const mutateAsync = mutation.mutateAsync;
  const start = useCallback(
    (input: RouterInputs["taskControl"]["redmineRequest"]) => {
      const current = ++generation.current;
      setId("");
      setInitial(undefined);
      setStartError("");
      setStarting(true);
      void mutateAsync(input)
        .then((data) => {
          if (current !== generation.current) return;
          setInitial(data);
          setId(data.request_id);
        })
        .catch((error: unknown) => {
          if (current === generation.current)
            setStartError(
              error instanceof Error ? error.message : String(error),
            );
        })
        .finally(() => {
          if (current === generation.current) setStarting(false);
        });
    },
    [mutateAsync],
  );
  const reset = useCallback(() => {
    generation.current++;
    setId("");
    setInitial(undefined);
    setStartError("");
    setStarting(false);
  }, []);
  const data = id ? (status.data ?? initial) : initial;
  return {
    start,
    reset,
    data,
    pending: starting || (!!data && ["queued", "leased"].includes(data.state)),
    error: startError || (id ? status.error?.message : "") || data?.error || "",
  };
}

function ExportSelect({
  label,
  items,
  value,
  onSelect,
}: {
  label: string;
  items: { id: number; name: string }[];
  value: number;
  onSelect: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs">{label}</span>
      <CheckboxDropdown
        asChild={false}
        position="right"
        ariaLabel={label}
        items={items.map((item) => ({
          key: String(item.id),
          value: item.name,
          selected: item.id === value,
        }))}
        disabled={!items.length}
        handleSelect={(_, item) => onSelect(Number(item.key))}
      >
        <span className="block truncate rounded-[5px] border border-transparent px-2 py-1.5 text-left text-xs text-light-1000 hover:border-light-300 hover:bg-light-200 dark:text-dark-1000 dark:hover:border-dark-200 dark:hover:bg-dark-100">
          {items.find((item) => item.id === value)?.name ?? t`Select project`}
        </span>
      </CheckboxDropdown>
    </div>
  );
}

export default function RedmineExport({
  cardPublicId,
  revision,
  disabled,
}: {
  cardPublicId: string;
  revision: number;
  disabled: boolean;
}) {
  const utils = api.useUtils();
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState(0);
  const [tracker, setTracker] = useState(0);
  const [status, setStatus] = useState(0);
  const [priority, setPriority] = useState(0);
  const [custom, setCustom] = useState<Record<number, string>>({});
  const projectsJob = useBotRequest(cardPublicId);
  const optionsJob = useBotRequest(cardPublicId);
  const previewJob = useBotRequest(cardPublicId);
  const exportJob = useBotRequest(cardPublicId);
  const operationJob = useBotRequest(cardPublicId);
  const restored = api.taskControl.redmineExportState.useQuery(
    { cardPublicId },
    {
      enabled: open,
      retry: false,
      refetchInterval: (query) =>
        query.state.data &&
        ["queued", "leased"].includes(query.state.data.state)
          ? 2000
          : false,
    },
  );
  const projects =
    projectsJob.data?.result?.kind === "projects"
      ? projectsJob.data.result.data
      : null;
  const options =
    optionsJob.data?.result?.kind === "options"
      ? optionsJob.data.result.data
      : null;
  const preview =
    previewJob.data?.result?.kind === "preview"
      ? previewJob.data.result.data
      : null;
  const exported = exportJob.data ?? restored.data;
  const exportResult =
    exported?.result?.kind === "export" ? exported.result.data : null;
  const operationResult =
    operationJob.data?.result?.kind === "operation"
      ? operationJob.data.result.data
      : null;
  const result = operationResult ?? exportResult;
  const linked = result?.status === "linked";
  useEffect(() => {
    if (linked) {
      setOpen(false);
      void utils.taskControl.card.invalidate({ cardPublicId });
    }
  }, [linked, cardPublicId, utils.taskControl.card]);
  const clearPreview = () => previewJob.reset();
  const loadProjects = () =>
    projectsJob.start({
      cardPublicId,
      request_key: generateUID(),
      kind: "projects",
    });
  const pending =
    [projectsJob, optionsJob, previewJob, exportJob, operationJob].some(
      (job) => job.pending,
    ) ||
    (!!exported && ["queued", "leased"].includes(exported.state)) ||
    result?.status === "pending" ||
    result?.status === "created";
  const error =
    projectsJob.error ||
    optionsJob.error ||
    previewJob.error ||
    exportJob.error ||
    operationJob.error ||
    exported?.error ||
    result?.errors.join("\n") ||
    restored.error?.message;
  return (
    <div className="space-y-3 border-t border-light-300 pt-4 dark:border-dark-300">
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => {
          if (!open) loadProjects();
          setOpen(!open);
        }}
      >{t`Export snapshot to Redmine`}</Button>
      {open && (
        <div className="space-y-3">
          <p className="text-xs">{t`Kan remains the task-control system. Export creates a one-time snapshot.`}</p>
          {pending && (
            <p
              role="status"
              className="text-xs text-light-900 dark:text-dark-900"
            >{t`Waiting for bot. You can return to this card later.`}</p>
          )}
          {projects?.demo && (
            <p className="text-xs text-amber-700 dark:text-amber-300">{t`LOCAL DEMO — no real Redmine issue will be created.`}</p>
          )}
          <ExportSelect
            label={t`Redmine project`}
            items={projects?.items ?? []}
            value={project}
            onSelect={(value) => {
              setProject(value);
              setTracker(0);
              setStatus(0);
              setPriority(0);
              setCustom({});
              clearPreview();
              optionsJob.start({
                cardPublicId,
                request_key: generateUID(),
                kind: "options",
                project_id: value,
              });
            }}
          />
          {projects?.has_more && (
            <Button
              variant="ghost"
              size="xs"
              disabled={projectsJob.pending}
              onClick={() => {
                if (projects.next_cursor)
                  projectsJob.start({
                    cardPublicId,
                    request_key: generateUID(),
                    kind: "projects",
                    cursor: projects.next_cursor,
                  });
              }}
            >{t`Load more`}</Button>
          )}
          {options && (
            <>
              <ExportSelect
                label={t`Tracker`}
                items={options.trackers}
                value={tracker || options.trackers[0]?.id || 0}
                onSelect={(value) => {
                  setTracker(value);
                  clearPreview();
                }}
              />
              <ExportSelect
                label={t`Status`}
                items={options.statuses}
                value={status || options.statuses[0]?.id || 0}
                onSelect={(value) => {
                  setStatus(value);
                  clearPreview();
                }}
              />
              <ExportSelect
                label={t`Priority`}
                items={options.priorities}
                value={priority || options.priorities[0]?.id || 0}
                onSelect={(value) => {
                  setPriority(value);
                  clearPreview();
                }}
              />
              {options.custom_fields.map((field) => (
                <label key={field.id} className="block text-xs">
                  {field.name}
                  {field.required ? " *" : ""}
                  <Input
                    aria-label={field.name}
                    value={custom[field.id] ?? ""}
                    onChange={(event) => {
                      setCustom({ ...custom, [field.id]: event.target.value });
                      clearPreview();
                    }}
                  />
                </label>
              ))}
              <Button
                variant="secondary"
                size="xs"
                isLoading={previewJob.pending}
                disabled={
                  previewJob.pending ||
                  !!exported ||
                  !options.trackers.length ||
                  !options.statuses.length ||
                  !options.priorities.length
                }
                onClick={() => {
                  const trackerId = tracker || options.trackers[0]?.id;
                  const statusId = status || options.statuses[0]?.id;
                  const priorityId = priority || options.priorities[0]?.id;
                  if (trackerId && statusId && priorityId)
                    previewJob.start({
                      cardPublicId,
                      request_key: generateUID(),
                      kind: "preview",
                      expected_revision: revision,
                      project_id: project,
                      tracker_id: trackerId,
                      status_id: statusId,
                      priority_id: priorityId,
                      custom_fields: options.custom_fields.map((field) => ({
                        id: field.id,
                        value: custom[field.id] ?? "",
                      })),
                    });
                }}
              >{t`Preview export`}</Button>
            </>
          )}
          {preview && (
            <div className="space-y-2 text-xs">
              {preview.warnings.map((warning) => (
                <p key={warning} className="text-amber-700 dark:text-amber-300">
                  {warning}
                </p>
              ))}
              {preview.errors.map((message) => (
                <p key={message} className="text-red-600">
                  {message}
                </p>
              ))}
              <details>
                <summary>{t`Full exported snapshot`}</summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-light-200 p-2 dark:bg-dark-200">
                  {JSON.stringify(preview.snapshot, null, 2)}
                </pre>
              </details>
              <Button
                size="sm"
                isLoading={exportJob.pending}
                disabled={
                  exportJob.pending ||
                  !!exported ||
                  preview.errors.length > 0 ||
                  Date.parse(preview.expires_at) < Date.now()
                }
                onClick={() =>
                  exportJob.start({
                    cardPublicId,
                    request_key: generateUID(),
                    kind: "export",
                    preview_id: preview.preview_id,
                  })
                }
              >{t`Confirm export`}</Button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          {error && !exported && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setProject(0);
                optionsJob.reset();
                previewJob.reset();
                loadProjects();
              }}
            >{t`Retry`}</Button>
          )}
          {result?.operation_id && !linked && (
            <Button
              variant="ghost"
              size="xs"
              isLoading={operationJob.pending}
              onClick={() => {
                operationJob.start({
                  cardPublicId,
                  request_key: generateUID(),
                  kind: "operation",
                  operation_id: result.operation_id,
                });
              }}
            >{t`Check export status`}</Button>
          )}
          {(exported?.state === "unknown" || result?.status === "unknown") && (
            <p className="text-xs text-amber-700 dark:text-amber-300">{t`Export outcome is unknown. Ask the administrator to reconcile it; do not create another export.`}</p>
          )}
        </div>
      )}
    </div>
  );
}
