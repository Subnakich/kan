import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { t } from "@lingui/core/macro";
import { useRef, useState } from "react";

import {
  formatTaskDeadline,
  parseTaskDateTime,
  taskDateTimeInput,
} from "@kan/shared/utils";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import { invalidateCard } from "~/utils/cardInvalidation";

interface Props {
  cardPublicId: string;
  dueDate: Date | null | undefined;
  isLoading?: boolean;
  disabled?: boolean;
}
export function DueDateSelector({
  cardPublicId,
  dueDate,
  isLoading,
  disabled,
}: Props) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const mutation = api.card.update.useMutation({
    onSuccess: async () => {
      await invalidateCard(utils, cardPublicId);
      await utils.board.byId.invalidate();
      await utils.taskControl.card.invalidate();
    },
    onError: (error) =>
      showPopup({
        header: t`Unable to update due date`,
        message: error.message,
        icon: "error",
      }),
  });
  return (
    <Popover className="relative w-full">
      {({ close }) => (
        <>
          <PopoverButton
            type="button"
            disabled={Boolean(isLoading) || Boolean(disabled)}
            className="flex h-full w-full items-center rounded-[5px] border border-transparent px-2 py-1 text-left text-xs text-light-1000 hover:border-light-300 hover:bg-light-200 disabled:opacity-60 dark:text-dark-1000 dark:hover:border-dark-200 dark:hover:bg-dark-100"
            onClick={() => {
              setValue(dueDate ? taskDateTimeInput(dueDate) : "");
            }}
          >
            {dueDate
              ? `${formatTaskDeadline(dueDate)} ${t`MSK`}`
              : t`Set due date`}
          </PopoverButton>
          <PopoverPanel className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-light-200 bg-light-50 p-3 shadow-lg dark:border-dark-500 dark:bg-dark-200">
            <label className="text-xs">
              {t`Deadline — Moscow time (UTC+3)`}
              <Input
                ref={inputRef}
                aria-label={t`Deadline — Moscow time (UTC+3)`}
                type="datetime-local"
                step={60}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onInput={(event) => setValue(event.currentTarget.value)}
                className="mt-2 px-2 text-xs"
              />
            </label>
            <p className="mt-2 text-xs text-light-700 dark:text-dark-800">{t`Deadline is optional.`}</p>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="xs"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate(
                    { cardPublicId, dueDate: null },
                    { onSuccess: () => close() },
                  )
                }
              >{t`Clear`}</Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => close()}
              >{t`Cancel`}</Button>
              <Button
                size="xs"
                isLoading={mutation.isPending}
                disabled={mutation.isPending || !parseTaskDateTime(value)}
                onClick={() => {
                  const date = parseTaskDateTime(
                    inputRef.current?.value ?? value,
                  );
                  if (date)
                    mutation.mutate(
                      { cardPublicId, dueDate: date },
                      { onSuccess: () => close() },
                    );
                }}
              >{t`Save`}</Button>
            </div>
          </PopoverPanel>
        </>
      )}
    </Popover>
  );
}
