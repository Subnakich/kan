import { t } from "@lingui/core/macro";
import { HiOutlineClipboardDocumentCheck } from "react-icons/hi2";

import Button from "~/components/Button";
import Modal from "~/components/modal";
import { useModal } from "~/providers/modal";
import { usePopup } from "~/providers/popup";
import { api } from "~/utils/api";
import BulkReviewForm from "./BulkReviewForm";

export default function TaskBoardControl({
  boardPublicId,
  canEdit,
  canReview,
}: {
  boardPublicId: string;
  canEdit: boolean;
  canReview: boolean;
}) {
  const utils = api.useUtils();
  const { showPopup } = usePopup();
  const { openModal, isOpen, modalContentType, entityId } = useModal();
  const state = api.taskControl.board.useQuery(
    { boardPublicId },
    { enabled: boardPublicId.length === 12 },
  );
  const enable = api.taskControl.enable.useMutation({
    onSuccess: async () => {
      await utils.taskControl.invalidate();
      await utils.board.byId.invalidate();
    },
    onError: (error) =>
      showPopup({
        header: t`Task control`,
        message: error.message,
        icon: "error",
      }),
  });
  if (!state.data) return null;
  if (state.data.enabled)
    return (
      <>
        <span
          className="inline-flex items-center gap-2 px-2 py-2 text-xs font-medium text-light-700 dark:text-dark-800"
          title={t`Deadlines use Moscow time (UTC+3).`}
        >
          <HiOutlineClipboardDocumentCheck
            className="h-4 w-4"
            aria-hidden="true"
          />
          {t`Task control · MSK`}
        </span>
        {canReview && (
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<HiOutlineClipboardDocumentCheck className="h-4 w-4" />}
            onClick={() =>
              openModal("TASK_BULK_REVIEW", boardPublicId, undefined, false)
            }
          >
            {t`Review cards`}
          </Button>
        )}
        <Modal
          modalSize="lg"
          positionFromTop="sm"
          isVisible={
            isOpen &&
            modalContentType === "TASK_BULK_REVIEW" &&
            entityId === boardPublicId
          }
        >
          {isOpen &&
            modalContentType === "TASK_BULK_REVIEW" &&
            entityId === boardPublicId && (
              <BulkReviewForm boardPublicId={boardPublicId} />
            )}
        </Modal>
      </>
    );
  return (
    <Button
      variant="secondary"
      disabled={!canEdit || enable.isPending}
      onClick={() => enable.mutate({ boardPublicId })}
      title={t`Enable on an empty board. Creates Review, Queue, In Progress, Blocked and Done.`}
    >{t`Enable task control`}</Button>
  );
}
