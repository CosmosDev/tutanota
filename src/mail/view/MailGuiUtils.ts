import type { MailModel } from "../model/MailModel"
import type { File as TutanotaFile, Mail, MailFolder } from "../../api/entities/tutanota/TypeRefs.js"
import { createMail } from "../../api/entities/tutanota/TypeRefs.js"
import { LockedError, PreconditionFailedError } from "../../api/common/error/RestError"
import { Dialog } from "../../gui/base/Dialog"
import { locator } from "../../api/main/MainLocator"
import { getFolderIcon, getIndentedFolderNameForDropdown, getMoveTargetFolderSystems } from "../model/MailUtils"
import { AllIcons } from "../../gui/base/Icon"
import { Icons } from "../../gui/base/icons/Icons"
import type { InlineImages } from "./MailViewer"
import { isApp, isDesktop } from "../../api/common/Env"
import { assertNotNull, neverNull, noOp, promiseMap } from "@tutao/tutanota-utils"
import { MailFolderType, MailReportType } from "../../api/common/TutanotaConstants"
import { getElementId, getListId } from "../../api/common/utils/EntityUtils"
import { reportMailsAutomatically } from "./MailReportDialog"
import { DataFile } from "../../api/common/DataFile"
import { lang, TranslationKey } from "../../misc/LanguageViewModel"
import { FileController } from "../../file/FileController"
import { DomRectReadOnlyPolyfilled, Dropdown, PosRect } from "../../gui/base/Dropdown.js"
import { ButtonSize } from "../../gui/base/ButtonSize.js"
import { modal } from "../../gui/base/Modal.js"
import { assertSystemFolderOfType, isOfTypeOrSubfolderOf, isSpamOrTrashFolder } from "../../api/common/mail/CommonMailUtils.js"
import { ConversationViewModel } from "./ConversationViewModel.js"

export async function showDeleteConfirmationDialog(mails: ReadonlyArray<Mail>): Promise<boolean> {
	let trashMails: Mail[] = []
	let moveMails: Mail[] = []
	for (let mail of mails) {
		const folder = locator.mailModel.getMailFolder(mail._id[0])
		const mailboxDetail = await locator.mailModel.getMailboxDetailsForMailListId(getListId(mail))
		if (mailboxDetail == null) {
			continue
		}
		const isFinalDelete = folder && isSpamOrTrashFolder(mailboxDetail.folders, folder)
		isFinalDelete ? trashMails.push(mail) : moveMails.push(mail)
	}

	let confirmationTextId: TranslationKey | null = null

	if (trashMails.length > 0) {
		if (moveMails.length > 0) {
			confirmationTextId = "finallyDeleteSelectedEmails_msg"
		} else {
			confirmationTextId = "finallyDeleteEmails_msg"
		}
	}

	if (confirmationTextId != null) {
		return Dialog.confirm(confirmationTextId, "ok_action")
	} else {
		return Promise.resolve(true)
	}
}

/**
 * @return whether emails were deleted
 */
export function promptAndDeleteMails(mailModel: MailModel, mails: ReadonlyArray<Mail>, onConfirm: () => void): Promise<boolean> {
	return showDeleteConfirmationDialog(mails).then((confirmed) => {
		if (confirmed) {
			onConfirm()
			return mailModel
				.deleteMails(mails)
				.then(() => true)
				.catch((e) => {
					//LockedError should no longer be thrown!?!
					if (e instanceof PreconditionFailedError || e instanceof LockedError) {
						return Dialog.message("operationStillActive_msg").then(() => false)
					} else {
						throw e
					}
				})
		} else {
			return Promise.resolve(false)
		}
	})
}

interface MoveMailsParams {
	mailModel: MailModel
	mails: ReadonlyArray<Mail>
	targetMailFolder: MailFolder
	isReportable?: boolean
}

/**
 * Moves the mails and reports them as spam if the user or settings allow it.
 * @return whether mails were actually moved
 */
export async function moveMails({ mailModel, mails, targetMailFolder, isReportable = true }: MoveMailsParams): Promise<boolean> {
	const details = await mailModel.getMailboxDetailsForMailListId(targetMailFolder.mails)
	if (details == null) {
		return false
	}
	const system = details.folders
	return mailModel
		.moveMails(mails, targetMailFolder)
		.then(async () => {
			if (isOfTypeOrSubfolderOf(system, targetMailFolder, MailFolderType.SPAM) && isReportable) {
				const reportableMails = mails.map((mail) => {
					// mails have just been moved
					const reportableMail = createMail(mail)
					reportableMail._id = [targetMailFolder.mails, getElementId(mail)]
					return reportableMail
				})
				const mailboxDetails = await mailModel.getMailboxDetailsForMailGroup(assertNotNull(targetMailFolder._ownerGroup))
				await reportMailsAutomatically(MailReportType.SPAM, mailModel, mailboxDetails, reportableMails)
			}

			return true
		})
		.catch((e) => {
			//LockedError should no longer be thrown!?!
			if (e instanceof LockedError || e instanceof PreconditionFailedError) {
				return Dialog.message("operationStillActive_msg").then(() => false)
			} else {
				throw e
			}
		})
}

export function archiveMails(mails: Mail[]): Promise<void> {
	if (mails.length > 0) {
		// assume all mails in the array belong to the same Mailbox
		return locator.mailModel.getMailboxFolders(mails[0]).then((folders) => {
			folders &&
				moveMails({
					mailModel: locator.mailModel,
					mails: mails,
					targetMailFolder: assertSystemFolderOfType(folders, MailFolderType.ARCHIVE),
				})
		})
	} else {
		return Promise.resolve()
	}
}

export function moveToInbox(mails: Mail[]): Promise<any> {
	if (mails.length > 0) {
		// assume all mails in the array belong to the same Mailbox
		return locator.mailModel.getMailboxFolders(mails[0]).then((folders) => {
			folders &&
				moveMails({
					mailModel: locator.mailModel,
					mails: mails,
					targetMailFolder: assertSystemFolderOfType(folders, MailFolderType.INBOX),
				})
		})
	} else {
		return Promise.resolve()
	}
}

export function getMailFolderIcon(mail: Mail): AllIcons {
	let folder = locator.mailModel.getMailFolder(mail._id[0])

	if (folder) {
		return getFolderIcon(folder)
	} else {
		return Icons.Folder
	}
}

export function replaceCidsWithInlineImages(
	dom: HTMLElement,
	inlineImages: InlineImages,
	onContext: (cid: string, arg1: MouseEvent | TouchEvent, arg2: HTMLElement) => unknown,
): Array<HTMLElement> {
	// all image tags which have cid attribute. The cid attribute has been set by the sanitizer for adding a default image.
	const imageElements: Array<HTMLElement> = Array.from(dom.querySelectorAll("img[cid]"))
	if (dom.shadowRoot) {
		const shadowImageElements: Array<HTMLElement> = Array.from(dom.shadowRoot.querySelectorAll("img[cid]"))
		imageElements.push(...shadowImageElements)
	}
	const elementsWithCid: HTMLElement[] = []
	imageElements.forEach((imageElement) => {
		const cid = imageElement.getAttribute("cid")

		if (cid) {
			const inlineImage = inlineImages.get(cid)

			if (inlineImage) {
				elementsWithCid.push(imageElement)
				imageElement.setAttribute("src", inlineImage.objectUrl)
				imageElement.classList.remove("tutanota-placeholder")

				if (isApp()) {
					// Add long press action for apps
					let timeoutId: TimeoutID | null
					let startCoords:
						| {
								x: number
								y: number
						  }
						| null
						| undefined
					imageElement.addEventListener("touchstart", (e: TouchEvent) => {
						const touch = e.touches[0]
						if (!touch) return
						startCoords = {
							x: touch.clientX,
							y: touch.clientY,
						}
						timeoutId = setTimeout(() => {
							onContext(inlineImage.cid, e, imageElement)
						}, 800)
					})
					imageElement.addEventListener("touchmove", (e: TouchEvent) => {
						const touch = e.touches[0]
						if (!touch || !startCoords || !timeoutId) return

						if (Math.abs(touch.clientX - startCoords.x) > 40 || Math.abs(touch.clientY - startCoords.y) > 40) {
							clearTimeout(timeoutId)
						}
					})
					imageElement.addEventListener("touchend", () => {
						timeoutId && clearTimeout(timeoutId)
					})
				}

				if (isDesktop()) {
					// add right click action for desktop apps
					imageElement.addEventListener("contextmenu", (e: MouseEvent) => {
						onContext(inlineImage.cid, e, imageElement)
						e.preventDefault()
					})
				}
			}
		}
	})
	return elementsWithCid
}

export function replaceInlineImagesWithCids(dom: HTMLElement): HTMLElement {
	const domClone = dom.cloneNode(true) as HTMLElement
	const inlineImages: Array<HTMLElement> = Array.from(domClone.querySelectorAll("img[cid]"))
	inlineImages.forEach((inlineImage) => {
		const cid = inlineImage.getAttribute("cid")
		inlineImage.setAttribute("src", "cid:" + (cid || ""))
		inlineImage.removeAttribute("cid")
	})
	return domClone
}

export type InlineImageReference = {
	cid: string
	objectUrl: string
	blob: Blob
}

export function createInlineImage(file: DataFile): InlineImageReference {
	const cid = Math.random().toString(30).substring(2)
	file.cid = cid
	return createInlineImageReference(file, cid)
}

function createInlineImageReference(file: DataFile, cid: string): InlineImageReference {
	const blob = new Blob([file.data], {
		type: file.mimeType,
	})
	const objectUrl = URL.createObjectURL(blob)
	return {
		cid,
		objectUrl,
		blob,
	}
}

export function cloneInlineImages(inlineImages: InlineImages): InlineImages {
	const newMap = new Map()
	inlineImages.forEach((v, k) => {
		const blob = new Blob([v.blob])
		const objectUrl = URL.createObjectURL(blob)
		newMap.set(k, {
			cid: v.cid,
			objectUrl,
			blob,
		})
	})
	return newMap
}

export function revokeInlineImages(inlineImages: InlineImages): void {
	inlineImages.forEach((v, k) => {
		URL.revokeObjectURL(v.objectUrl)
	})
}

export async function loadInlineImages(fileController: FileController, attachments: Array<TutanotaFile>, referencedCids: Array<string>): Promise<InlineImages> {
	const filesToLoad = getReferencedAttachments(attachments, referencedCids)
	const inlineImages = new Map()
	return promiseMap(filesToLoad, async (file) => {
		let dataFile = await fileController.getAsDataFile(file)
		const { htmlSanitizer } = await import("../../misc/HtmlSanitizer")
		dataFile = htmlSanitizer.sanitizeInlineAttachment(dataFile)
		const inlineImageReference = createInlineImageReference(dataFile, neverNull(file.cid))
		inlineImages.set(inlineImageReference.cid, inlineImageReference)
	}).then(() => inlineImages)
}

export function getReferencedAttachments(attachments: Array<TutanotaFile>, referencedCids: Array<string>): Array<TutanotaFile> {
	return attachments.filter((file) => referencedCids.find((rcid) => file.cid === rcid))
}

export async function showMoveMailsDropdown(
	model: MailModel,
	origin: PosRect,
	mails: readonly Mail[],
	opts?: { width?: number; withBackground?: boolean; onSelected?: () => unknown },
): Promise<void> {
	const { width = 300, withBackground = false, onSelected = noOp } = opts ?? {}
	const folders = await getMoveTargetFolderSystems(model, mails)
	if (folders.length === 0) return
	const folderButtons = folders.map((f) => ({
		label: () => getIndentedFolderNameForDropdown(f),
		click: () => {
			onSelected()
			moveMails({ mailModel: model, mails: mails, targetMailFolder: f.folder })
		},
		icon: getFolderIcon(f.folder),
		size: ButtonSize.Compact,
	}))

	const dropdown = new Dropdown(() => folderButtons, width)

	dropdown.setOrigin(new DomRectReadOnlyPolyfilled(origin.left, origin.top, origin.width, origin.height))
	modal.displayUnique(dropdown, withBackground)
}

export function getConversationTitle(conversationViewModel: ConversationViewModel): string {
	if (!conversationViewModel.isFinished()) {
		return lang.get("loading_msg")
	}
	const numberOfEmails = conversationViewModel.conversationItems().length
	if (numberOfEmails === 1) {
		return lang.get("oneEmail_label")
	} else {
		return lang.get("nbrOrEmails_label", { "{number}": numberOfEmails })
	}
}
