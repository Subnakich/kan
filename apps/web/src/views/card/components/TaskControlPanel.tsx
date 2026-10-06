import { t } from "@lingui/core/macro";
import { useEffect, useState } from "react";
import {
  HiOutlineArrowTopRightOnSquare,
  HiOutlineExclamationTriangle,
} from "react-icons/hi2";

import Avatar from "~/components/Avatar";
import Button from "~/components/Button";
import CheckboxDropdown from "~/components/CheckboxDropdown";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";
import RedmineExport from "./RedmineExport";

export default function TaskControlPanel({
  cardPublicId,
  disabled,
}: {
  cardPublicId: string;
  disabled: boolean;
}) {
  const utils = api.useUtils();
  const card = api.taskControl.card.useQuery(
    { cardPublicId },
    { enabled: cardPublicId.length === 12 },
  );
  const [blocker, setBlocker] = useState("");
  const [editingBlocker, setEditingBlocker] = useState(false);
  const [error, setError] = useState("");
  const invalidate = async () => {
    await utils.taskControl.card.invalidate({ cardPublicId });
    await invalidateCard(utils, cardPublicId);
    await utils.board.byId.invalidate();
  };
  const update = api.taskControl.update.useMutation({
    onSuccess: async () => {
      setEditingBlocker(false);
      await invalidate();
    },
    onError: (error) => setError(error.message),
  });
  const move = api.card.update.useMutation({
    onSuccess: invalidate,
    onError: (error) => setError(error.message),
  });
  useEffect(() => {
    setBlocker(card.data?.snapshot.blocker_reason ?? "");
  }, [card.data?.snapshot.blocker_reason]);
  if (!card.data) return null;
  const { snapshot, members, columns } = card.data;
  const queue = columns.find((column) => column.role === "queue");
  const owner = members.find(
    (member) => member.member_public_id === snapshot.owner_member_public_id,
  );
  return (
    <section aria-label={t`Task control`} className="space-y-4 text-sm">
      {members.length > 1 && (
        <div className="flex items-start">
          <p className="my-2 w-[100px] shrink-0 pr-2 text-sm font-medium">{t`Responsible person`}</p>
          <div className="min-w-0 flex-1 py-1">
            <CheckboxDropdown
              ariaLabel={t`Responsible person`}
              asChild={false}
              disabled={disabled || update.isPending}
              position="right"
              items={members.map((member) => ({
                key: member.member_public_id,
                value: member.name,
                selected:
                  member.member_public_id === snapshot.owner_member_public_id,
                leftIcon: (
                  <Avatar size="xs" name={member.name} email={member.email} />
                ),
              }))}
              handleSelect={(_, member) => {
                setError("");
                update.mutate({
                  cardPublicId,
                  owner_member_public_id: member.key,
                });
              }}
            >
              <span className="flex w-full items-center gap-2 rounded-[5px] border border-transparent px-2 py-1 text-left text-xs text-light-1000 hover:border-light-300 hover:bg-light-200 dark:text-dark-1000 dark:hover:border-dark-200 dark:hover:bg-dark-100">
                {owner && (
                  <Avatar size="xs" name={owner.name} email={owner.email} />
                )}
                <span className="truncate">
                  {owner?.name ?? t`Select a responsible person`}
                </span>
              </span>
            </CheckboxDropdown>
          </div>
        </div>
      )}
      {members.length === 0 && (
        <p className="text-xs text-light-700 dark:text-dark-800">{t`Add a card member to assign a responsible person.`}</p>
      )}
      <div>
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          iconLeft={<HiOutlineExclamationTriangle className="h-4 w-4" />}
          aria-expanded={editingBlocker}
          onClick={() => {
            setBlocker(snapshot.blocker_reason ?? "");
            setEditingBlocker(!editingBlocker);
          }}
        >
          {snapshot.blocker_reason ? t`Edit blocker` : t`Add blocker`}
        </Button>
        {!editingBlocker && snapshot.blocker_reason && (
          <p className="mt-2 whitespace-pre-wrap break-words text-xs">
            {snapshot.blocker_reason}
          </p>
        )}
        {editingBlocker && (
          <div className="mt-2 space-y-2">
            <label
              htmlFor="task-blocker"
              className="text-xs"
            >{t`Blocker reason`}</label>
            <textarea
              id="task-blocker"
              disabled={disabled}
              value={blocker}
              rows={3}
              onChange={(event) => setBlocker(event.target.value)}
              className="block w-full resize-y rounded-md border-0 bg-white/5 px-3 py-1.5 text-sm shadow-sm ring-1 ring-inset ring-light-600 focus:ring-2 focus:ring-light-700 dark:text-dark-1000 dark:ring-dark-700 dark:focus:ring-dark-700"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="xs"
                disabled={update.isPending}
                onClick={() => setEditingBlocker(false)}
              >{t`Cancel`}</Button>
              <Button
                size="xs"
                isLoading={update.isPending}
                disabled={disabled}
                onClick={() => {
                  setError("");
                  update.mutate({
                    cardPublicId,
                    blocker_reason: blocker || null,
                  });
                }}
              >{t`Save`}</Button>
            </div>
          </div>
        )}
      </div>
      {snapshot.source && (
        <details className="space-y-2 text-xs">
          <summary className="cursor-pointer py-1 font-medium">{t`Task source`}</summary>
          <p>{snapshot.source.meeting.title}</p>
          <blockquote className="border-l-2 border-light-400 pl-2 dark:border-dark-500">
            {snapshot.source.timestamp && `${snapshot.source.timestamp} · `}
            {snapshot.source.quote}
          </blockquote>
          {snapshot.source.due_text && (
            <p>
              {t`Original deadline`}: {snapshot.source.due_text}
            </p>
          )}
          {snapshot.source.review_notes.map((note, index) => (
            <p key={index}>{note}</p>
          ))}
          {snapshot.acceptance_criteria.length > 0 && (
            <div>
              <p className="font-medium">{t`Acceptance criteria`}</p>
              <ul className="list-inside list-disc">
                {snapshot.acceptance_criteria.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}
      {snapshot.column_role === "review" && queue && (
        <div className="space-y-3 border-t border-light-300 pt-4 dark:border-dark-300">
          <p className="text-xs leading-5 text-light-700 dark:text-dark-800">{t`Check the description and responsible person. Deadline is optional. Delete unnecessary cards; confirm the rest.`}</p>
          <Button
            size="sm"
            disabled={disabled || update.isPending}
            isLoading={move.isPending}
            onClick={() => {
              setError("");
              if (
                !snapshot.title.trim() ||
                !snapshot.description?.replace(/<[^>]*>/g, "").trim() ||
                !snapshot.owner_member_public_id
              ) {
                setError(
                  t`Add a title, description and responsible person before confirming.`,
                );
                return;
              }
              move.mutate({
                cardPublicId,
                listPublicId: queue.publicId,
                index: 0,
              });
            }}
          >{t`Confirm → Queue`}</Button>
        </div>
      )}
      {snapshot.redmine_link && (
        <div className="space-y-2 border-t border-light-300 pt-4 text-xs dark:border-dark-300">
          <Button
            size="xs"
            variant="secondary"
            href={snapshot.redmine_link.url}
            openInNewTab
            iconRight={<HiOutlineArrowTopRightOnSquare className="h-4 w-4" />}
          >
            Redmine {snapshot.redmine_link.display_id}
          </Button>
          <p className="leading-5 text-light-700 dark:text-dark-800">
            {snapshot.revision > snapshot.redmine_link.exported_revision
              ? t`Card changed after export. Redmine is a snapshot, not a live sync.`
              : t`Exported snapshot. Task control remains in Kan.`}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      {!snapshot.redmine_link && (
        <RedmineExport
          cardPublicId={cardPublicId}
          revision={snapshot.revision}
          disabled={disabled || snapshot.column_role === "review"}
        />
      )}
    </section>
  );
}
