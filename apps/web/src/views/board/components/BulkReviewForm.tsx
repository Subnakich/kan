import { t } from "@lingui/core/macro";
import { useState } from "react";

import type { RouterOutputs } from "~/utils/api";
import Button from "~/components/Button";
import { useModal } from "~/providers/modal";
import { api } from "~/utils/api";

type Result = RouterOutputs["taskControl"]["confirmReview"]["results"][number];

function reviewError(message: string) {
  switch (message) {
    case "Card changed. Reload and review it again":
      return t`Card changed. Review it again before confirming.`;
    case "Card is no longer in Review":
      return t`Card is no longer in Review.`;
    case "Add a title, description and responsible person before confirming":
      return t`Add a title, description and responsible person before confirming.`;
    case "Card not found":
    case "Card not found on this board":
      return t`Card is no longer available on this board.`;
    default:
      return t`Unable to confirm card. Reload and try again.`;
  }
}

export default function BulkReviewForm({
  boardPublicId,
}: {
  boardPublicId: string;
}) {
  const { closeModal } = useModal();
  const utils = api.useUtils();
  const cards = api.taskControl.reviewCards.useQuery({ boardPublicId });
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<(Result & { title: string })[]>([]);
  const [error, setError] = useState("");
  const confirm = api.taskControl.confirmReview.useMutation({
    onSuccess: (data) => {
      setResults(
        data.results.map((result) => ({
          ...result,
          title:
            cards.data?.find((card) => card.publicId === result.publicId)
              ?.title ?? result.publicId,
        })),
      );
      setSelected([]);
    },
    onError: () =>
      setError(
        t`Unable to confirm cards. Reload to check their current state before retrying.`,
      ),
    onSettled: async () => {
      await Promise.all([
        cards.refetch(),
        utils.board.byId.invalidate(),
        utils.taskControl.card.invalidate(),
        utils.card.byId.invalidate(),
      ]);
    },
  });
  const selectedCards = (cards.data ?? []).filter((card) =>
    selected.includes(card.publicId),
  );
  const ready = (cards.data ?? []).filter((card) => card.problems.length === 0);
  const confirmed = results.filter((result) => result.confirmed).length;
  const failures = results.filter((result) => !result.confirmed);

  return (
    <div className="space-y-4 p-5 text-sm text-light-1000 dark:text-dark-1000">
      <h2 className="text-lg font-semibold">{t`Review cards`}</h2>
      <p className="text-xs leading-5 text-light-700 dark:text-dark-800">
        {t`Check the selected cards before confirming. Ready cards move to Queue; rejected cards stay in Review. Deadline is optional. Up to 100 cards at a time.`}
      </p>
      {cards.isLoading && <p>{t`Loading...`}</p>}
      {cards.error && (
        <div role="alert">
          <p>{t`Unable to load cards awaiting review.`}</p>
          <Button
            variant="ghost"
            onClick={() => void cards.refetch()}
          >{t`Retry`}</Button>
        </div>
      )}
      {!cards.isLoading && !cards.error && !cards.data?.length && (
        <p>{t`No cards awaiting review.`}</p>
      )}
      {!!cards.data?.length && (
        <>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="xs"
              disabled={confirm.isPending || !ready.length}
              onClick={() =>
                setSelected(ready.slice(0, 100).map((card) => card.publicId))
              }
            >
              {t`Select ready cards`}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={confirm.isPending || !selected.length}
              onClick={() => setSelected([])}
            >{t`Clear selection`}</Button>
          </div>
          <ul className="max-h-[45vh] space-y-1 overflow-y-auto pr-1 scrollbar">
            {cards.data.map((card) => (
              <li
                key={card.publicId}
                className="rounded-md border border-light-300 p-3 dark:border-dark-300"
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={t`Select card: ${card.title}`}
                    className="mt-1 h-[14px] w-[14px] rounded bg-transparent"
                    checked={selected.includes(card.publicId)}
                    disabled={
                      confirm.isPending ||
                      (!selected.includes(card.publicId) &&
                        selected.length >= 100)
                    }
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, card.publicId]
                          : current.filter((id) => id !== card.publicId),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <a
                      href={`/cards/${card.publicId}?returnUrl=${encodeURIComponent(`/boards/${boardPublicId}`)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-words font-medium hover:underline"
                    >
                      {card.title}
                    </a>
                    <p className="whitespace-pre-wrap break-words text-xs text-light-700 dark:text-dark-800">
                      {card.problems.includes("description")
                        ? t`No description`
                        : card.description?.replace(/<[^>]*>/g, "").trim()}
                    </p>
                    <p className="text-xs">
                      {card.ownerName ?? t`No responsible person`}
                      {card.dueDate &&
                        ` · ${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" }).format(card.dueDate)} MSK`}
                    </p>
                    {!!card.problems.length && (
                      <p className="text-xs text-red-600">{t`Add a title, description and responsible person before confirming.`}</p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {!!results.length && (
        <div role="status" className="space-y-2 text-xs">
          <p>{t`Confirmed: ${confirmed}. Rejected: ${failures.length}.`}</p>
          {failures.map((result) => (
            <p key={result.publicId} className="text-red-600">
              {result.title}: {reviewError(result.error ?? "")}
            </p>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-light-300 pt-4 dark:border-dark-300">
        <Button
          variant="ghost"
          disabled={confirm.isPending}
          onClick={closeModal}
        >{t`Close`}</Button>
        <Button
          disabled={confirm.isPending || !selectedCards.length}
          isLoading={confirm.isPending}
          onClick={() => {
            setError("");
            setResults([]);
            confirm.mutate({
              boardPublicId,
              cards: selectedCards.map((card) => ({
                cardPublicId: card.publicId,
                expectedRevision: card.revision,
              })),
            });
          }}
        >{t`Confirm selected → Queue`}</Button>
      </div>
    </div>
  );
}
