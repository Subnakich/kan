import { t } from "@lingui/core/macro";
import { useState } from "react";

import { isValidMemberDisplayName } from "@kan/shared";

import Button from "~/components/Button";
import Input from "~/components/Input";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { useWorkspace } from "~/providers/workspace";
import { api } from "~/utils/api";

export function EditMemberNameModal() {
  const { entityId, entityLabel, closeModal } = useModal();
  const { workspace } = useWorkspace();
  const { showPopup } = usePopup();
  const utils = api.useUtils();
  const [name, setName] = useState(entityLabel);
  const [error, setError] = useState("");
  const rename = api.member.updateDisplayName.useMutation({
    onSuccess: async () => {
      closeModal();
      showPopup({
        header: t`Display name updated`,
        message: t`The member's display name has been updated.`,
        icon: "success",
      });
      // Account names are global, including other boards and card participants.
      await utils.invalidate();
    },
    onError: () =>
      setError(
        t`Unable to change the name. Check your permissions, reload and try again.`,
      ),
  });

  return (
    <form
      className="space-y-4 p-5 text-light-1000 dark:text-dark-1000"
      onSubmit={(event) => {
        event.preventDefault();
        if (rename.isPending) return;
        if (!isValidMemberDisplayName(name)) {
          setError(
            t`Use 3-255 characters without email or control characters.`,
          );
          return;
        }
        setError("");
        rename.mutate({
          workspacePublicId: workspace.publicId,
          memberPublicId: entityId,
          name: name.trim(),
        });
      }}
    >
      <h2 className="text-md font-medium">{t`Change member name`}</h2>
      <p className="text-sm text-light-900 dark:text-dark-900">
        {t`This changes the account name in all workspaces. Email, task assignments and bot links stay unchanged.`}
      </p>
      <label className="block space-y-2 text-sm">
        <span>{t`Display name`}</span>
        <Input
          aria-label={t`Display name`}
          autoFocus
          value={name}
          maxLength={255}
          disabled={rename.isPending}
          errorMessage={error}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={rename.isPending}
          onClick={closeModal}
        >{t`Cancel`}</Button>
        <Button
          type="submit"
          disabled={name.trim() === entityLabel.trim()}
          isLoading={rename.isPending}
        >{t`Save`}</Button>
      </div>
    </form>
  );
}
