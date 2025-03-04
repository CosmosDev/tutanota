import {
	AccountType,
	AlarmInterval,
	CalendarAttendeeStatus,
	EndType,
	FeatureType,
	getAttendeeStatus,
	RepeatPeriod,
	ShareCapability,
	TimeFormat,
} from "../../api/common/TutanotaConstants"
import type { CalendarEvent, CalendarRepeatRule, Contact, EncryptedMailAddress, Mail, MailboxProperties } from "../../api/entities/tutanota/TypeRefs.js"
import { CalendarEventTypeRef, createCalendarEvent, createCalendarEventAttendee, createEncryptedMailAddress } from "../../api/entities/tutanota/TypeRefs.js"
import { AlarmInfo, createAlarmInfo, createDateWrapper, DateWrapper, RepeatRule } from "../../api/entities/sys/TypeRefs.js"
import type { MailboxDetail } from "../../mail/model/MailModel"
import stream from "mithril/stream"
import Stream from "mithril/stream"
import { copyMailAddress, getDefaultSenderFromUser, getEnabledMailAddressesWithUser, RecipientField } from "../../mail/model/MailUtils"
import {
	CalendarEventValidity,
	checkEventValidity,
	createRepeatRuleWithValues,
	generateUid,
	getAllDayDateUTCFromZone,
	getDiffInDays,
	getEventEnd,
	getEventStart,
	getNextHalfHour,
	getRepeatEndTime,
	getStartOfDayWithZone,
	getStartOfNextDayWithZone,
	incrementByRepeatPeriod,
	incrementSequence,
	prepareCalendarDescription,
} from "./CalendarUtils"
import { isCustomizationEnabledForCustomer } from "../../api/common/utils/Utils"
import {
	addMapEntry,
	arrayEqualsWithPredicate,
	assertNotNull,
	clone,
	deleteMapEntry,
	downcast,
	incrementDate,
	neverNull,
	noOp,
	ofClass,
} from "@tutao/tutanota-utils"
import {
	cleanMailAddress,
	findAttendeeInAddresses,
	findRecipientWithAddress,
	generateEventElementId,
	getAllDayDateUTC,
	isAllDayEvent,
} from "../../api/common/utils/CommonCalendarUtils"
import type { CalendarInfo } from "../model/CalendarModel"
import { CalendarModel } from "../model/CalendarModel"
import { DateTime } from "luxon"
import { NotFoundError, PayloadTooLargeError, TooManyRequestsError } from "../../api/common/error/RestError"
import type { CalendarUpdateDistributor } from "./CalendarUpdateDistributor"
import type { UserController } from "../../api/main/UserController"
import type { SendMailModel } from "../../mail/editor/SendMailModel"
import { UserError } from "../../api/main/UserError"
import { EntityClient } from "../../api/common/EntityClient"
import { BusinessFeatureRequiredError } from "../../api/main/BusinessFeatureRequiredError"
import { hasCapabilityOnGroup } from "../../sharing/GroupUtils"
import { Time } from "../../api/common/utils/Time"
import { hasError } from "../../api/common/utils/ErrorCheckUtils"
import { Recipient, RecipientType } from "../../api/common/recipients/Recipient"
import { ResolveMode } from "../../api/main/RecipientsModel.js"
import { TIMESTAMP_ZERO_YEAR } from "@tutao/tutanota-utils/dist/DateUtils"
import { getSenderName } from "../../misc/MailboxPropertiesUtils.js"

// whether to close dialog
export type EventCreateResult = boolean

const enum EventType {
	OWN = "own",
	// event in our own calendar and we are organizer
	SHARED_RO = "shared_ro",
	// event in shared calendar with read permission
	SHARED_RW = "shared_rw",
	// event in shared calendar with write permission
	INVITE = "invite", // invite from calendar invitation which is not stored in calendar yet, or event stored and we are not organizer
}

export type Guest = {
	address: EncryptedMailAddress
	type: RecipientType
	status: CalendarAttendeeStatus
}
export type SendMailPurpose = "invite" | "update" | "cancel" | "response"
type SendMailModelFactory = (arg1: SendMailPurpose) => SendMailModel
export type RepeatData = {
	frequency: RepeatPeriod
	interval: number
	endType: EndType
	endValue: number
	excludedDates: Array<Date>
}
type ShowProgressCallback = (arg0: Promise<unknown>) => unknown
type InitEventTypeReturn = {
	eventType: EventType
	organizer: EncryptedMailAddress | null
	possibleOrganizers: Array<EncryptedMailAddress>
}

/**
 * ViewModel for viewing/editing the event. Takes care of sending out updates.
 */
export class CalendarEventViewModel {
	readonly summary: Stream<string>
	readonly selectedCalendar: Stream<CalendarInfo | null>
	startDate!: Date
	endDate!: Date
	// Null start or end time means the user input was invalid
	startTime: Time | null = null
	endTime: Time | null = null
	private _allDay: boolean = false
	get allDay(): boolean {
		return this._allDay
	}

	repeat: RepeatData | null = null
	calendars: ReadonlyMap<Id, CalendarInfo>
	readonly attendees: Stream<ReadonlyArray<Guest>>
	organizer: EncryptedMailAddress | null
	readonly possibleOrganizers: ReadonlyArray<EncryptedMailAddress>
	readonly location: Stream<string>
	note: string
	readonly amPmFormat: boolean
	readonly existingEvent: CalendarEvent | null
	private _oldStartTime: Time | null = null
	readonly _zone: string
	// We keep alarms read-only so that view can diff just array and not all elements
	alarms: ReadonlyArray<AlarmInfo>
	// UserController already keeps track of user updates, it is better to not have our own reference to the user, we might miss
	// important updates like premium upgrade
	readonly _userController: UserController
	readonly _eventType: EventType
	readonly _distributor: CalendarUpdateDistributor
	readonly _calendarModel: CalendarModel
	readonly _inviteModel: SendMailModel
	readonly _updateModel: SendMailModel
	readonly _cancelModel: SendMailModel
	readonly _ownMailAddresses: Array<string>
	readonly _entityClient: EntityClient
	// We want to observe changes to it. To not mutate accidentally without stream update we keep it immutable.
	readonly _guestStatuses: Stream<ReadonlyMap<string, CalendarAttendeeStatus>>
	readonly _sendModelFactory: () => SendMailModel

	/** Our own attendee, it should not be included in any of the sendMailModels. */
	readonly _ownAttendee: Stream<EncryptedMailAddress | null>
	_responseTo: Mail | null
	readonly sendingOutUpdate: Stream<boolean>
	_processing: boolean
	hasBusinessFeature: Stream<boolean>
	isForceUpdates: Stream<boolean>
	readonly initialized: Promise<CalendarEventViewModel>

	constructor(
		userController: UserController,
		distributor: CalendarUpdateDistributor,
		calendarModel: CalendarModel,
		entityClient: EntityClient,
		mailboxDetail: MailboxDetail,
		mailboxProperties: MailboxProperties,
		sendMailModelFactory: SendMailModelFactory,
		date: Date,
		zone: string,
		calendars: ReadonlyMap<Id, CalendarInfo>,
		existingEvent: CalendarEvent | null,
		responseTo: Mail | null,
		resolveRecipientsLazily: boolean,
	) {
		this._distributor = distributor
		this._calendarModel = calendarModel
		this._entityClient = entityClient
		this._userController = userController
		this._responseTo = responseTo ?? null
		this._inviteModel = sendMailModelFactory("invite")
		this._updateModel = sendMailModelFactory("update")
		this._cancelModel = sendMailModelFactory("cancel")
		this.summary = stream("")

		this._sendModelFactory = () => sendMailModelFactory("response")

		this._ownMailAddresses = getEnabledMailAddressesWithUser(mailboxDetail, userController.userGroupInfo)
		this._ownAttendee = stream<EncryptedMailAddress | null>(null)
		this.sendingOutUpdate = stream<boolean>(false)
		this._processing = false
		this.hasBusinessFeature = stream<boolean>(false)
		this.isForceUpdates = stream<boolean>(false)
		this.location = stream("")
		this.note = ""
		this.amPmFormat = userController.userSettingsGroupRoot.timeFormat === TimeFormat.TWELVE_HOURS
		this.existingEvent = existingEvent ?? null
		this._zone = zone
		this._guestStatuses = this._initGuestStatus(existingEvent, resolveRecipientsLazily)
		this.attendees = this._initAttendees()
		const { eventType, organizer, possibleOrganizers } = this.initEventTypeAndOrganizers(existingEvent, calendars, mailboxProperties, userController)
		this._eventType = eventType
		this.organizer = organizer
		this.possibleOrganizers = possibleOrganizers
		this.alarms = []
		this.calendars = calendars
		this.selectedCalendar = stream<CalendarInfo | null>(this.getAvailableCalendars()[0] ?? null)
		this.initialized = Promise.resolve().then(async () => {
			if (existingEvent) {
				if (existingEvent.invitedConfidentially != null) {
					this.setConfidential(existingEvent.invitedConfidentially)
				}
			}

			if (existingEvent) {
				await this._applyValuesFromExistingEvent(existingEvent, calendars)
			} else {
				// We care about passed time here, use it for default time values.
				this._setDefaultTimes(date)

				this.startDate = getStartOfDayWithZone(date, this._zone)
				this.endDate = getStartOfDayWithZone(date, this._zone)
			}

			await this.updateCustomerFeatures()
			return this
		})
	}

	// reschedule this event by moving the start and end time by delta milliseconds
	// also moves any exclusions by the same amount
	rescheduleEvent(delta: number) {
		const oldStartDate = new Date(this.startDate)
		const startTime = this.startTime

		if (startTime) {
			oldStartDate.setHours(startTime.hours)
			oldStartDate.setMinutes(startTime.minutes)
		}

		const newStartDate = new Date(oldStartDate.getTime() + delta)

		const oldEndDate = new Date(this.endDate)
		const endTime = this.endTime

		if (endTime) {
			oldEndDate.setHours(endTime.hours)
			oldEndDate.setMinutes(endTime.minutes)
		}
		const newEndDate = new Date(oldEndDate.getTime() + delta)
		this.startDate = getStartOfDayWithZone(newStartDate, this._zone)
		this.endDate = getStartOfDayWithZone(newEndDate, this._zone)
		this.startTime = Time.fromDate(newStartDate)
		this.endTime = Time.fromDate(newEndDate)
		this.deleteExcludedDates()
	}

	async _applyValuesFromExistingEvent(existingEvent: CalendarEvent, calendars: ReadonlyMap<Id, CalendarInfo>): Promise<void> {
		this.summary(existingEvent.summary)
		const calendarForGroup = calendars.get(neverNull(existingEvent._ownerGroup))

		if (calendarForGroup) {
			this.selectedCalendar(calendarForGroup)
		}

		this._allDay = isAllDayEvent(existingEvent)
		this.startDate = getStartOfDayWithZone(getEventStart(existingEvent, this._zone), this._zone)

		if (this._allDay) {
			this.endDate = incrementDate(getEventEnd(existingEvent, this._zone), -1)

			// We don't care about passed time here, just use current one as default
			this._setDefaultTimes()
		} else {
			const startDate = DateTime.fromJSDate(getEventStart(existingEvent, this._zone), {
				zone: this._zone,
			})
			const endDate = DateTime.fromJSDate(getEventEnd(existingEvent, this._zone), {
				zone: this._zone,
			})
			this.startTime = Time.fromDateTime(startDate)
			this.endTime = Time.fromDateTime(endDate)
			this.endDate = getStartOfDayWithZone(endDate.toJSDate(), this._zone)
		}

		if (existingEvent.repeatRule) {
			const existingRule = existingEvent.repeatRule
			const repeat: RepeatData = {
				frequency: downcast(existingRule.frequency),
				interval: Number(existingRule.interval),
				endType: downcast(existingRule.endType),
				endValue: existingRule.endType === EndType.Count ? Number(existingRule.endValue) : 1,
				excludedDates: existingRule.excludedDates.map(({ date }) => date),
			}

			if (existingRule.endType === EndType.UntilDate) {
				repeat.endValue = getRepeatEndTime(existingRule, this._allDay, this._zone).getTime()
			}

			this.repeat = repeat
		} else {
			this.repeat = null
		}

		this.location(existingEvent.location)
		this.note = prepareCalendarDescription(existingEvent.description)
		const alarms = await this._calendarModel.loadAlarms(existingEvent.alarmInfos, this._userController.user)

		for (let alarm of alarms) {
			this.addAlarm(downcast(alarm.alarmInfo.trigger))
		}
	}

	/**
	 * Determines the event type, the organizer of the event and possible organizers in accordance with the capabilities for events (see table).
	 * Note that the only "real" organizer that an event can have is the owner of the calendar.
	 * If events are created by someone we share our personal calendar with, the organizer is overwritten and set to our own primary address.
	 * Possible organizers are all email addresses of the user, allowed to modify the organizer. This is only the owner of the calendar ("real" organizer)
	 * and only if there are no guests.
	 *
	 * Capability for events is fairly complicated:
	 * Note: share "shared" means "not owner of the calendar". Calendar always looks like personal for the owner.
	 *
	 * | Calendar           | is organizer     | can edit details    | can modify own attendance | can modify guests | can modify organizer
	 * |--------------------|------------------|---------------------|---------------------------|-------------------|----------
	 * | Personal (own)     | yes              | yes                 | yes                       | yes               | yes
	 * | Personal  (invite) | no               | yes (local)         | yes                       | no                | no
	 * | Personal  (own)    | no****           | yes                 | yes                       | yes               | yes
	 * | Shared             | yes****          | yes***              | no                        | no*               | no*
	 * | Shared             | no               | no                  | no**                      | no*               | no*
	 *
	 *   * we don't allow inviting guests in other people's calendar because later only organizer can modify event and
	 *   we don't want to prevent calendar owner from editing events in their own calendar.
	 *
	 *   ** this is not "our" copy of the event, from the point of organizer we saw it just accidentally.
	 *   Later we might support proposing ourselves as attendee but currently organizer should be asked to
	 *   send out the event.
	 *
	 *   *** depends on share capability and whether there are attendees.
	 *
	 *   **** The creator of the event. Will be overwritten with owner of the calendar by this function.
	 */
	private initEventTypeAndOrganizers(
		existingEvent: CalendarEvent | null,
		calendars: ReadonlyMap<Id, CalendarInfo>,
		mailboxProperties: MailboxProperties,
		userController: UserController,
	): InitEventTypeReturn {
		const ownDefaultSender = this.addressToMailAddress(mailboxProperties, getDefaultSenderFromUser(userController))

		if (!existingEvent) {
			return {
				eventType: EventType.OWN,
				organizer: ownDefaultSender,
				possibleOrganizers: this.ownPossibleOrganizers(mailboxProperties),
			}
		} else {
			// OwnerGroup is not set for events from file
			const calendarInfoForEvent = existingEvent._ownerGroup && calendars.get(existingEvent._ownerGroup)
			const existingOrganizer = existingEvent.organizer

			if (calendarInfoForEvent) {
				if (calendarInfoForEvent.shared) {
					return {
						eventType: hasCapabilityOnGroup(this._userController.user, calendarInfoForEvent.group, ShareCapability.Write)
							? EventType.SHARED_RW
							: EventType.SHARED_RO,
						organizer: existingOrganizer ? copyMailAddress(existingOrganizer) : null,
						possibleOrganizers: existingOrganizer ? [existingOrganizer] : [],
					}
				} else {
					//For an event in a personal calendar there are 3 options (see table)
					//1. We are the organizer of the event (or the event does not have an organizer yet and we become the organizer of the event)
					//2. If we are not the organizer and the event does not have guests, it was created by someone we shared our calendar with (also considered our own event)
					if (!existingOrganizer || this._ownMailAddresses.includes(existingOrganizer.address) || existingEvent.attendees.length === 0) {
						//we want to keep the existing organizer if it is one of our email addresses in all other cases we use our primary address
						const actualOrganizer =
							existingOrganizer && this._ownMailAddresses.includes(existingOrganizer.address) ? existingOrganizer : ownDefaultSender
						return {
							eventType: EventType.OWN,
							organizer: copyMailAddress(actualOrganizer),
							possibleOrganizers: this.hasGuests() ? [actualOrganizer] : this.ownPossibleOrganizers(mailboxProperties),
						}
					}
					//3. the event is an invitation
					else {
						return {
							eventType: EventType.INVITE,
							organizer: existingOrganizer,
							possibleOrganizers: [existingOrganizer],
						}
					}
				}
			} else {
				// We can edit new invites (from files)
				return {
					eventType: EventType.INVITE,
					organizer: existingOrganizer ? copyMailAddress(existingOrganizer) : null,
					possibleOrganizers: existingOrganizer ? [existingOrganizer] : [],
				}
			}
		}
	}

	_initGuestStatus(existingEvent: CalendarEvent | null, resolveRecipientsLazily: boolean): Stream<ReadonlyMap<string, CalendarAttendeeStatus>> {
		const newStatuses = new Map()

		if (existingEvent) {
			existingEvent.attendees
				.filter((attendee) => !hasError(attendee.address))
				.forEach((attendee) => {
					if (findAttendeeInAddresses([attendee], this._ownMailAddresses) != null) {
						this._ownAttendee(copyMailAddress(attendee.address))
					} else {
						this._updateModel.addRecipient(
							RecipientField.BCC,
							{
								name: attendee.address.name,
								address: attendee.address.address,
							},
							resolveRecipientsLazily ? ResolveMode.Lazy : ResolveMode.Eager,
						)
					}

					newStatuses.set(attendee.address.address, getAttendeeStatus(attendee))
				})
		}

		return stream<ReadonlyMap<string, CalendarAttendeeStatus>>(newStatuses)
	}

	async updateCustomerFeatures(): Promise<void> {
		if (this._userController.isInternalUser()) {
			const customer = await this._userController.loadCustomer()
			this.hasBusinessFeature(isCustomizationEnabledForCustomer(customer, FeatureType.BusinessFeatureEnabled))
		} else {
			this.hasBusinessFeature(false)
		}
	}

	_initAttendees(): Stream<ReadonlyArray<Guest>> {
		return stream
			.merge([this._inviteModel.onMailChanged, this._updateModel.onMailChanged, this._guestStatuses, this._ownAttendee] as Stream<unknown>[])
			.map(() => {
				const makeGuestList = (model: SendMailModel) => {
					return model.bccRecipients().map((recipient) => {
						const guest = {
							address: createEncryptedMailAddress({
								name: recipient.name,
								address: recipient.address,
							}),
							status: this._guestStatuses().get(recipient.address) || CalendarAttendeeStatus.NEEDS_ACTION,
							type: recipient.type,
						}
						return guest
					})
				}

				const guests = makeGuestList(this._inviteModel).concat(makeGuestList(this._updateModel))

				const ownAttendee = this._ownAttendee()

				if (ownAttendee) {
					guests.unshift({
						address: ownAttendee,
						status: this._guestStatuses().get(ownAttendee.address) || CalendarAttendeeStatus.ACCEPTED,
						type: RecipientType.INTERNAL,
					})
				}

				return guests as ReadonlyArray<Guest>
			})
	}

	_setDefaultTimes(date: Date = getNextHalfHour()) {
		const endTimeDate = new Date(date)
		endTimeDate.setMinutes(endTimeDate.getMinutes() + 30)
		this.startTime = Time.fromDate(date)
		this.endTime = Time.fromDate(endTimeDate)
	}

	private ownPossibleOrganizers(mailboxProperties: MailboxProperties): Array<EncryptedMailAddress> {
		return this._ownMailAddresses.map((address) => this.addressToMailAddress(mailboxProperties, address))
	}

	findOwnAttendee(): Guest | null {
		return findAttendeeInAddresses(this.attendees(), this._ownMailAddresses)
	}

	setStartTime(value: Time | null) {
		this._oldStartTime = this.startTime
		this.startTime = value

		if (this.startDate.getTime() === this.endDate.getTime()) {
			this._adjustEndTime()
		}

		this.deleteExcludedDates()
	}

	setEndTime(value: Time | null) {
		this.endTime = value
	}

	setAllDay(newAllDay: boolean): void {
		if (newAllDay === this._allDay) return
		this._allDay = newAllDay
		if (this.repeat == null) return
		if (newAllDay) {
			// we want to keep excluded dates if all we do is switching between all-day and normal event
			this.repeat.excludedDates = this.repeat.excludedDates.map((date) => getAllDayDateUTC(date))
		} else if (this.startTime) {
			const startTime = this.startTime
			this.repeat.excludedDates = this.repeat.excludedDates.map((date) => startTime.toDate(date))
		} else {
			// we have an invalid start time. to save, we need to change it, which means we're going to delete these anyway.
			// no point in keeping wrong data around or having the behaviour depend on the value of the time field
			this.deleteExcludedDates()
		}
	}

	addGuest(mailAddress: string, contact: Contact | null) {
		// 1: if the attendee already exists, do nothing
		// 2: if the attendee is not yourself, add to the invite model
		// 3: if the attendee is yourself and you already exist as an attendee, remove yourself
		// 4: add the attendee
		// 5: add organizer if you are not already in the list
		// We don't add a guest if they are already an attendee
		// even though the SendMailModel handles deduplication, we need to check here because recipients shouldn't be duplicated across the 3 models either
		if (findAttendeeInAddresses(this.attendees(), [mailAddress]) != null) {
			return
		}

		const isOwnAttendee = this._ownMailAddresses.includes(mailAddress)

		// SendMailModel handles deduplication
		// this.attendees will be updated when the model's recipients are updated
		if (!isOwnAttendee) {
			this._inviteModel.addRecipient(RecipientField.BCC, {
				address: mailAddress,
				contact,
			})
		}
		const status = isOwnAttendee ? CalendarAttendeeStatus.ACCEPTED : CalendarAttendeeStatus.ADDED

		// If we exist as an attendee and the added guest is also an attendee, then remove the existing ownAttendee
		// and the new one will be added in the next step
		if (isOwnAttendee) {
			const ownAttendee = this.findOwnAttendee()

			if (ownAttendee) {
				this._guestStatuses(deleteMapEntry(this._guestStatuses(), ownAttendee.address.address))
			}
		}

		// if this guy wasn't already an attendee with a status
		if (!this._guestStatuses().has(mailAddress)) {
			this._guestStatuses(addMapEntry(this._guestStatuses(), mailAddress, status))
		}

		// this duplicated condition check may or may not be redundant to do here
		if (isOwnAttendee) {
			const newOrganizer = findRecipientWithAddress(this.possibleOrganizers, mailAddress)
			if (newOrganizer) this.setOrganizer(newOrganizer)
		}

		// Add organizer as attendee if not currenly in the list
		if (this.attendees().length === 1 && this.findOwnAttendee() == null) {
			this.selectGoing(CalendarAttendeeStatus.ACCEPTED)
		}
	}

	getGuestPassword(guest: Guest): string {
		return (
			this._inviteModel.getPassword(guest.address.address) ||
			this._updateModel.getPassword(guest.address.address) ||
			this._cancelModel.getPassword(guest.address.address)
		)
	}

	isReadOnlyEvent(): boolean {
		// For the RW calendar we have two similar cases:
		//
		// Case 1:
		// Owner of the calendar created the event and invited some people. We, user with whom calendar was shared as RW, are seeing this event.
		// We cannot modify that event even though we have RW permission because we are the not organizer.
		// If the event is changed, the update must be sent out and we cannot do that because we are not the organizer.
		//
		// Case 2:
		// Owner of the calendar received an invite and saved the event to the calendar. We, user with whom the calendar was shared as RW, are seeing this event.
		// We can (theoretically) modify the event locally because we don't need to send any updates but we cannot change attendance because this would require sending an email.
		// But we don't want to allow editing the event to make it more understandable for everyone.
		return this._eventType === EventType.SHARED_RO || (this._eventType === EventType.SHARED_RW && this.attendees().length > 0)
	}

	_adjustEndTime() {
		if (!this.startTime || !this.endTime || !this._oldStartTime) {
			return
		}

		const endTotalMinutes = this.endTime.hours * 60 + this.endTime.minutes
		const startTotalMinutes = this.startTime.hours * 60 + this.startTime.minutes
		const diff = Math.abs(endTotalMinutes - this._oldStartTime.hours * 60 - this._oldStartTime.minutes)
		const newEndTotalMinutes = startTotalMinutes + diff
		let newEndHours = Math.floor(newEndTotalMinutes / 60)

		if (newEndHours > 23) {
			newEndHours = 23
		}

		const newEndMinutes = newEndTotalMinutes % 60
		this.endTime = new Time(newEndHours, newEndMinutes)
	}

	setStartDate(date: Date) {
		if (date.getTime() === this.startDate.getTime()) {
			return
		}

		// The custom ID for events is derived from the unix timestamp, and sorting
		// the negative ids is a challenge we decided not to
		// tackle because it is a rare case.
		if (date && date.getFullYear() < TIMESTAMP_ZERO_YEAR) {
			const thisYear = new Date().getFullYear()
			let newDate = new Date(date)
			newDate.setFullYear(thisYear)
			this.startDate = newDate
		} else {
			const diff = getDiffInDays(this.startDate, date)
			this.endDate = DateTime.fromJSDate(this.endDate, {
				zone: this._zone,
			})
				.plus({
					days: diff,
				})
				.toJSDate()
			this.startDate = date

			this.deleteExcludedDates()
		}
	}

	setEndDate(date: Date) {
		this.endDate = date
	}

	onRepeatPeriodSelected(repeatPeriod: RepeatPeriod | null) {
		if (this.repeat?.frequency === repeatPeriod) {
			// repeat null => we will return if repeatPeriod is null
			// repeat not null => we return if the repeat period is null or it did not change.
			return
		} else if (repeatPeriod == null) {
			this.repeat = null
		} else if (this.repeat != null) {
			this.repeat.frequency = repeatPeriod
			this.deleteExcludedDates()
		} else {
			// new repeat rule, populate with default values.
			this.repeat = {
				interval: 1,
				endType: EndType.Never,
				endValue: 1,
				frequency: repeatPeriod,
				excludedDates: [],
			}
		}
	}

	onEndOccurencesSelected(endValue: number) {
		if (this.repeat && this.repeat.endType === EndType.Count && this.repeat.endValue !== endValue) {
			this.repeat.endValue = endValue
			this.deleteExcludedDates()
		}
	}

	onRepeatEndDateSelected(endDate: Date) {
		const { repeat } = this

		if (repeat && repeat.endType === EndType.UntilDate && repeat.endValue !== endDate.getTime()) {
			repeat.endValue = endDate.getTime()
			this.deleteExcludedDates()
		}
	}

	onRepeatIntervalChanged(interval: number) {
		if (this.repeat && this.repeat.interval !== interval) {
			this.repeat.interval = interval
			this.deleteExcludedDates()
		}
	}

	onRepeatEndTypeChanged(endType: EndType) {
		const { repeat } = this

		if (repeat && repeat.endType !== endType) {
			repeat.endType = endType
			this.deleteExcludedDates()

			if (endType === EndType.UntilDate) {
				repeat.endValue = incrementByRepeatPeriod(new Date(), RepeatPeriod.MONTHLY, 1, this._zone).getTime()
			} else {
				repeat.endValue = 1
			}
		}
	}

	addAlarm(trigger: AlarmInterval) {
		const alarm = createCalendarAlarm(generateEventElementId(Date.now()), trigger)
		this.alarms = this.alarms.concat(alarm)
	}

	changeAlarm(identifier: string, trigger: AlarmInterval | null) {
		const newAlarms = this.alarms.slice()

		for (let i = 0; i < newAlarms.length; i++) {
			if (newAlarms[i].alarmIdentifier === identifier) {
				if (trigger) {
					newAlarms[i].trigger = trigger
				} else {
					newAlarms.splice(i, 1)
				}

				this.alarms = newAlarms
				break
			}
		}
	}

	changeDescription(description: string) {
		this.note = description
	}

	canModifyGuests(): boolean {
		// It is not allowed to modify guests in shared calendar or invite.
		const selectedCalendar = this.selectedCalendar()
		return selectedCalendar != null && !selectedCalendar.shared && this._eventType !== EventType.INVITE
	}

	async shouldShowSendInviteNotAvailable(): Promise<boolean> {
		if (this._userController.user.accountType === AccountType.FREE) {
			return true
		}

		if (this._userController.user.accountType === AccountType.EXTERNAL) {
			return false
		}

		return !this.hasBusinessFeature() && !(await this._userController.isNewPaidPlan())
	}

	removeAttendee(guest: Guest) {
		const existingRecipient = this.existingEvent && findAttendeeInAddresses(this.existingEvent.attendees, [guest.address.address])

		for (const model of [this._inviteModel, this._updateModel, this._cancelModel]) {
			const recipientInfo = findRecipientWithAddress(model.bccRecipients(), guest.address.address)

			if (recipientInfo) {
				model.removeRecipient(recipientInfo, RecipientField.BCC)
				const newStatuses = new Map(this._guestStatuses())
				newStatuses.delete(recipientInfo.address)

				this._guestStatuses(newStatuses)
			}
		}

		if (existingRecipient) {
			this._cancelModel.addRecipient(RecipientField.BCC, {
				address: existingRecipient.address.address,
				name: existingRecipient.address.name,
			})
		}
	}

	canModifyOwnAttendance(): boolean {
		// We can always modify own attendance in own event. Also can modify if it's invite in our calendar and we are invited.
		return this._eventType === EventType.OWN || (this._eventType === EventType.INVITE && !!this.findOwnAttendee())
	}

	canModifyOrganizer(): boolean {
		// We can only modify the organizer if it is our own event and there are no guests
		return this._eventType === EventType.OWN && !this.hasGuests()
	}

	private hasGuests() {
		return (
			this.existingEvent &&
			this.existingEvent.attendees.length > 0 &&
			!(this.existingEvent.attendees.length === 1 && findAttendeeInAddresses([this.existingEvent.attendees[0]], this._ownMailAddresses) != null)
		)
	}

	setOrganizer(newOrganizer: EncryptedMailAddress): void {
		if (this.canModifyOrganizer()) {
			this.organizer = newOrganizer

			// we always add the organizer to the attendee list
			this._ownAttendee(newOrganizer)
		}
	}

	canModifyAlarms(): boolean {
		return this._eventType === EventType.OWN || this._eventType === EventType.INVITE || this._eventType === EventType.SHARED_RW
	}

	async deleteEvent(): Promise<void> {
		const event = this.existingEvent
		if (event) {
			try {
				// We must always be in attendees so we just check that there's more than one attendee
				if (this._eventType === EventType.OWN && event.attendees.length > 1) {
					await this.sendCancellation(event)
				}
				return this._calendarModel.deleteEvent(event).catch(ofClass(NotFoundError, noOp))
			} catch (e) {
				if (!(e instanceof NotFoundError)) {
					throw e
				}
			}
		}
	}

	/**
	 * calling this adds an exclusion for the event instance contained in this viewmodel to the repeat rule of the event,
	 * which will cause the instance to not be rendered or fire alarms.
	 * Exclusions are the start date/time of the event.
	 *
	 * the list of exclusions is maintained sorted from earliest to latest.
	 */
	async excludeThisOccurrence(): Promise<void> {
		const existingEvent = this.existingEvent
		if (existingEvent == null) return
		const selectedCalendar = this.selectedCalendar()
		if (!selectedCalendar) return
		// original event -> first occurrence of the series, the one that was created by the user
		// existing event -> the event instance that's displayed in the calendar and was clicked, essentially a copy of original event but with different start time
		const originalEvent = existingEvent.repeatRule ? await this._entityClient.load(CalendarEventTypeRef, existingEvent._id) : existingEvent
		if (!originalEvent || originalEvent.repeatRule == null) return
		const event = clone(originalEvent)
		event.attendees = originalEvent.attendees.map((a) => createCalendarEventAttendee(a))
		const excludedDates = event.repeatRule!.excludedDates
		const timeToInsert = existingEvent.startTime.getTime()
		const insertionIndex = excludedDates.findIndex(({ date }) => date.getTime() >= timeToInsert)
		// as of now, our maximum repeat frequency is 1/day. this means that we could truncate this to the current day (no time)
		// but then we run into problems with time zones, since we'd like to delete the n-th occurrence of an event, but detect
		// if an event is excluded by the start of the utc day it falls on, which may depend on time zone if it's truncated to the local start of day
		// where the exclusion is created.
		const wrapperToInsert = createDateWrapper({ date: existingEvent.startTime })
		if (insertionIndex < 0) {
			excludedDates.push(wrapperToInsert)
		} else {
			excludedDates.splice(insertionIndex, 0, wrapperToInsert)
		}

		const calendarForEvent = this.calendars.get(assertNotNull(existingEvent._ownerGroup, "tried to add exclusion on event without ownerGroup"))
		if (calendarForEvent == null) {
			console.log("why does this event not have a calendar?")
			return
		}
		await this._calendarModel.updateEvent(event, this.alarms.slice(), this._zone, calendarForEvent.groupRoot, existingEvent)
	}

	async waitForResolvedRecipients(): Promise<void> {
		await Promise.all([
			this._inviteModel.waitForResolvedRecipients(),
			this._updateModel.waitForResolvedRecipients(),
			this._cancelModel.waitForResolvedRecipients(),
		])
	}

	isForceUpdateAvailable(): boolean {
		return this._eventType === EventType.OWN && this._hasUpdatableAttendees()
	}

	/**
	 * @reject UserError
	 */
	async saveAndSend({
		askForUpdates,
		askInsecurePassword,
		showProgress,
	}: {
		askForUpdates: () => Promise<"yes" | "no" | "cancel">
		askInsecurePassword: () => Promise<boolean>
		showProgress: ShowProgressCallback
	}): Promise<EventCreateResult> {
		await this.initialized

		if (this._processing) {
			return Promise.resolve(false)
		}

		this._processing = true
		return Promise.resolve()
			.then(async () => {
				await this.waitForResolvedRecipients()

				const newEvent = this._initializeNewEvent()

				const newAlarms = this.alarms.slice()

				// We want to avoid asking whether to send out updates in case nothing has changed
				if (this._eventType === EventType.OWN && (this.isForceUpdates() || this._hasChanges(newEvent))) {
					// It is our own event. We might need to send out invites/cancellations/updates
					return this._sendNotificationAndSave(askInsecurePassword, askForUpdates, showProgress, newEvent, newAlarms)
				} else if (this._eventType === EventType.INVITE) {
					// We have been invited by another person (internal/ unsecure external)
					return this._respondToOrganizerAndSave(showProgress, assertNotNull(this.existingEvent), newEvent, newAlarms)
				} else {
					// Either this is an event in a shared calendar. We cannot send anything because it's not our event.
					// Or no changes were made that require sending updates and we just save other changes.
					const p = this._saveEvent(newEvent, newAlarms)

					showProgress(p)
					return p.then(() => true)
				}
			})
			.catch(
				ofClass(PayloadTooLargeError, () => {
					throw new UserError("requestTooLarge_msg")
				}),
			)
			.finally(() => {
				this._processing = false
			})
	}

	private async sendCancellation(event: CalendarEvent): Promise<any> {
		const updatedEvent = clone(event)

		// This is guaranteed to be our own event.
		updatedEvent.sequence = incrementSequence(updatedEvent.sequence, true)
		const cancelAddresses = event.attendees.filter((a) => findAttendeeInAddresses([a], this._ownMailAddresses) == null).map((a) => a.address)

		try {
			for (const address of cancelAddresses) {
				this._cancelModel.addRecipient(RecipientField.BCC, {
					name: address.name,
					address: address.address,
					contact: null,
				})

				const recipient = await this._cancelModel.getRecipient(RecipientField.BCC, address.address)!.resolved()

				// We cannot send a notification to external recipients without a password, so we exclude them
				if (this._cancelModel.isConfidential()) {
					if (recipient.type === RecipientType.EXTERNAL && !this._cancelModel.getPassword(recipient.address)) {
						this._cancelModel.removeRecipient(recipient, RecipientField.BCC, false)
					}
				}
			}
			if (this._cancelModel.allRecipients().length) {
				await this._distributor.sendCancellation(updatedEvent, this._cancelModel)
			}
		} catch (e) {
			if (e instanceof TooManyRequestsError) {
				throw new UserError("mailAddressDelay_msg") // This will be caught and open error dialog
			} else {
				throw e
			}
		}
	}

	_saveEvent(newEvent: CalendarEvent, newAlarms: Array<AlarmInfo>): Promise<void> {
		if (this._userController.user.accountType === AccountType.EXTERNAL) {
			return Promise.resolve()
		}

		const groupRoot = assertNotNull(this.selectedCalendar()).groupRoot

		if (this.existingEvent == null || this.existingEvent._id == null) {
			return this._calendarModel.createEvent(newEvent, newAlarms, this._zone, groupRoot)
		} else {
			return this._calendarModel.updateEvent(newEvent, newAlarms, this._zone, groupRoot, this.existingEvent).then(noOp)
		}
	}

	_hasUpdatableAttendees(): boolean {
		return this._updateModel.bccRecipients().length > 0
	}

	_sendNotificationAndSave(
		askInsecurePassword: () => Promise<boolean>,
		askForUpdates: () => Promise<"yes" | "no" | "cancel">,
		showProgress: ShowProgressCallback,
		newEvent: CalendarEvent,
		newAlarms: Array<AlarmInfo>,
	): Promise<boolean> {
		// ask for update
		const askForUpdatesAwait = this._hasUpdatableAttendees()
			? this.isForceUpdates()
				? Promise.resolve("yes") // we do not ask again because the user has already indicated that they want to send updates
				: askForUpdates()
			: Promise.resolve("no")

		// no updates possible
		const passwordCheck = () => (this.hasInsecurePasswords() && this.containsExternalRecipients() ? askInsecurePassword() : Promise.resolve(true))

		return askForUpdatesAwait.then(async (updateResponse) => {
			if (updateResponse === "cancel") {
				return false
			} else if (
				(await this.shouldShowSendInviteNotAvailable()) && // we check again to prevent updates after cancelling business or updates for an imported event
				(updateResponse === "yes" || this._inviteModel.bccRecipients().length || this._cancelModel.bccRecipients().length)
			) {
				throw new BusinessFeatureRequiredError("businessFeatureRequiredInvite_msg")
			}

			// Do check passwords if there are new recipients. We already made decision for those who we invited before
			return Promise.resolve(this._inviteModel.bccRecipients().length ? passwordCheck() : true).then((passwordCheckPassed) => {
				if (!passwordCheckPassed) {
					// User said to not send despite insecure password, stop
					return false
				}

				// Invites are cancellations are sent out independent of the updates decision
				const p = this._sendInvite(newEvent)
					.then(() =>
						this._cancelModel.bccRecipients().length ? this._distributor.sendCancellation(newEvent, this._cancelModel) : Promise.resolve(),
					)
					.then(() => this._saveEvent(newEvent, newAlarms))
					.then(() => (updateResponse === "yes" ? this._distributor.sendUpdate(newEvent, this._updateModel) : Promise.resolve()))
					.then(() => true)

				showProgress(p)
				return p
			})
		})
	}

	_sendInvite(event: CalendarEvent): Promise<void> {
		const newAttendees = event.attendees.filter((a) => a.status === CalendarAttendeeStatus.ADDED)

		if (newAttendees.length > 0) {
			return this._distributor.sendInvite(event, this._inviteModel).then(() => {
				newAttendees.forEach((a) => {
					if (a.status === CalendarAttendeeStatus.ADDED) {
						a.status = CalendarAttendeeStatus.NEEDS_ACTION
					}

					this._guestStatuses(addMapEntry(this._guestStatuses(), a.address.address, CalendarAttendeeStatus.NEEDS_ACTION))
				})
			})
		} else {
			return Promise.resolve()
		}
	}

	_respondToOrganizerAndSave(
		showProgress: ShowProgressCallback,
		existingEvent: CalendarEvent,
		newEvent: CalendarEvent,
		newAlarms: Array<AlarmInfo>,
	): Promise<boolean> {
		// We are not using this._findAttendee() because we want to search it on the event, before our modifications
		const ownAttendee = findAttendeeInAddresses(existingEvent.attendees, this._ownMailAddresses)

		const selectedOwnAttendeeStatus = ownAttendee && this._guestStatuses().get(ownAttendee.address.address)

		let sendPromise = Promise.resolve()

		if (ownAttendee && selectedOwnAttendeeStatus !== CalendarAttendeeStatus.NEEDS_ACTION && ownAttendee.status !== selectedOwnAttendeeStatus) {
			ownAttendee.status = assertNotNull(selectedOwnAttendeeStatus)

			const sendResponseModel = this._sendModelFactory()

			const organizer = assertNotNull(existingEvent.organizer)
			sendResponseModel.addRecipient(RecipientField.TO, {
				name: organizer.name,
				address: organizer.address,
			})
			sendPromise = this._distributor
				.sendResponse(newEvent, sendResponseModel, ownAttendee.address.address, this._responseTo, assertNotNull(selectedOwnAttendeeStatus))
				.then(() => sendResponseModel.dispose())
		}

		const p = sendPromise.then(() => this._saveEvent(newEvent, newAlarms))
		showProgress(p)
		return p.then(() => true)
	}

	selectGoing(going: CalendarAttendeeStatus) {
		if (this.canModifyOwnAttendance()) {
			const ownAttendee = this._ownAttendee()

			if (ownAttendee) {
				this._guestStatuses(addMapEntry(this._guestStatuses(), ownAttendee.address, going))
			} else if (this._eventType === EventType.OWN) {
				// use the default sender as the organizer
				const newOwnAttendee = createEncryptedMailAddress({
					name: this._inviteModel.getSenderName(),
					address: this._inviteModel.getSender(),
				})

				this._ownAttendee(newOwnAttendee)

				this._guestStatuses(addMapEntry(this._guestStatuses(), newOwnAttendee.address, going))
			}
		}
	}

	createRepeatRule(newEvent: CalendarEvent, repeat: RepeatData): RepeatRule {
		const interval = repeat.interval || 1
		const repeatRule = createRepeatRuleWithValues(repeat.frequency, interval)
		const stopType = repeat.endType
		repeatRule.endType = stopType
		repeatRule.excludedDates = repeat.excludedDates.map((date) => createDateWrapper({ date }))

		if (stopType === EndType.Count) {
			const count = repeat.endValue

			if (isNaN(count) || Number(count) < 1) {
				repeatRule.endType = EndType.Never
			} else {
				repeatRule.endValue = String(count)
			}
		} else if (stopType === EndType.UntilDate) {
			const repeatEndDate = getStartOfNextDayWithZone(new Date(repeat.endValue), this._zone)

			if (repeatEndDate < getEventStart(newEvent, this._zone)) {
				throw new UserError("startAfterEnd_label")
			} else {
				// We have to save repeatEndDate in the same way we save start/end times because if one is timzone
				// dependent and one is not then we have interesting bugs in edge cases (event created in -11 could
				// end on another date in +12). So for all day events end date is UTC-encoded all day event and for
				// regular events it is just a timestamp.
				repeatRule.endValue = String((this._allDay ? getAllDayDateUTCFromZone(repeatEndDate, this._zone) : repeatEndDate).getTime())
			}
		}

		return repeatRule
	}

	setConfidential(confidential: boolean): void {
		this._inviteModel.setConfidential(confidential)

		this._updateModel.setConfidential(confidential)

		this._cancelModel.setConfidential(confidential)
	}

	isConfidential(): boolean {
		return this._inviteModel.isConfidential() && this._updateModel.isConfidential() && this._cancelModel.isConfidential()
	}

	updatePassword(guest: Guest, password: string) {
		const guestAddress = guest.address.address
		const inInvite = findRecipientWithAddress(this._inviteModel.bccRecipients(), guestAddress)

		if (inInvite) {
			this._inviteModel.setPassword(inInvite.address, password)
		}

		const inUpdate = findRecipientWithAddress(this._updateModel.bccRecipients(), guestAddress)

		if (inUpdate) {
			this._updateModel.setPassword(inUpdate.address, password)
		}

		const inCancel = findRecipientWithAddress(this._cancelModel.bccRecipients(), guestAddress)

		if (inCancel) {
			this._updateModel.setPassword(inCancel.address, password)
		}
	}

	shouldShowPasswordFields(): boolean {
		return this.isConfidential() && this._eventType === EventType.OWN
	}

	getPasswordStrength(guest: Guest): number {
		const address = guest.address.address

		const getStrength = (model: SendMailModel) => {
			const recipient = findRecipientWithAddress(model.allRecipients(), address)
			return recipient ? model.getPasswordStrength(recipient) : null
		}

		const inviteStrength = getStrength(this._inviteModel)
		if (inviteStrength != null) return inviteStrength
		const updateStrength = getStrength(this._updateModel)
		return updateStrength != null ? updateStrength : 0
	}

	hasInsecurePasswords(): boolean {
		if (!this.isConfidential()) {
			return false
		}

		if (this._eventType === EventType.INVITE) {
			// We can't receive invites from secure external users, so we don't have to reply with password
			return false
		} else {
			return this._inviteModel.hasInsecurePasswords() || this._updateModel.hasInsecurePasswords() || this._cancelModel.hasInsecurePasswords()
		}
	}

	containsExternalRecipients(): boolean {
		return (
			this._inviteModel.containsExternalRecipients() || this._updateModel.containsExternalRecipients() || this._cancelModel.containsExternalRecipients()
		)
	}

	getAvailableCalendars(): Array<CalendarInfo> {
		// Prevent moving the calendar to another calendar if you only have read permission or if the event has attendees.
		const calendarArray = Array.from(this.calendars.values())

		if (this.isReadOnlyEvent()) {
			return calendarArray.filter((calendarInfo) => calendarInfo.group._id === assertNotNull(this.existingEvent)._ownerGroup)
		} else if (this.attendees().length || this._eventType === EventType.INVITE) {
			// We don't allow inviting in a shared calendar. If we have attendees, we cannot select a shared calendar
			// We also don't allow accepting invites into shared calendars.
			return calendarArray.filter((calendarInfo) => !calendarInfo.shared)
		} else {
			return calendarArray.filter((calendarInfo) => hasCapabilityOnGroup(this._userController.user, calendarInfo.group, ShareCapability.Write))
		}
	}

	_allRecipients(): Array<Recipient> {
		return this._inviteModel.allRecipients().concat(this._updateModel.allRecipients()).concat(this._cancelModel.allRecipients())
	}

	dispose(): void {
		this._inviteModel.dispose()

		this._updateModel.dispose()

		this._cancelModel.dispose()
	}

	isInvite(): boolean {
		return this._eventType === EventType.INVITE
	}

	/**
	 * Keep in sync with _hasChanges().
	 */
	_initializeNewEvent(): CalendarEvent {
		// We have to use existing instance to get all the final fields correctly
		// Using clone feels hacky but otherwise we need to save all attributes of the existing event somewhere and if dialog is
		// cancelled we also don't want to modify passed event
		const newEvent = this.existingEvent ? clone(this.existingEvent) : createCalendarEvent()
		newEvent.sequence = incrementSequence(newEvent.sequence, this._eventType === EventType.OWN)
		let startDate = new Date(this.startDate)
		let endDate = new Date(this.endDate)

		if (this._allDay) {
			startDate = getAllDayDateUTCFromZone(startDate, this._zone)
			endDate = getAllDayDateUTCFromZone(getStartOfNextDayWithZone(endDate, this._zone), this._zone)
		} else {
			const startTime = this.startTime
			const endTime = this.endTime

			if (!startTime || !endTime) {
				throw new UserError("timeFormatInvalid_msg")
			}

			startDate = DateTime.fromJSDate(startDate, {
				zone: this._zone,
			})
				.set({
					hour: startTime.hours,
					minute: startTime.minutes,
				})
				.toJSDate()
			// End date is never actually included in the event. For the whole day event the next day
			// is the boundary. For the timed one the end time is the boundary.
			endDate = DateTime.fromJSDate(endDate, {
				zone: this._zone,
			})
				.set({
					hour: endTime.hours,
					minute: endTime.minutes,
				})
				.toJSDate()
		}

		newEvent.startTime = startDate
		newEvent.description = this.note
		newEvent.summary = this.summary()
		newEvent.location = this.location()
		newEvent.endTime = endDate
		newEvent.invitedConfidentially = this.isConfidential()
		newEvent.uid =
			this.existingEvent && this.existingEvent.uid ? this.existingEvent.uid : generateUid(assertNotNull(this.selectedCalendar()).group._id, Date.now())
		const repeat = this.repeat

		if (repeat == null) {
			newEvent.repeatRule = null
		} else {
			newEvent.repeatRule = this.createRepeatRule(newEvent, repeat)
		}

		newEvent.attendees = this.attendees().map((a) =>
			createCalendarEventAttendee({
				address: a.address,
				status: a.status,
			}),
		)
		newEvent.organizer = this.organizer

		switch (checkEventValidity(newEvent)) {
			case CalendarEventValidity.InvalidContainsInvalidDate:
				throw new UserError("invalidDate_msg")
			case CalendarEventValidity.InvalidEndBeforeStart:
				throw new UserError("startAfterEnd_label")
			case CalendarEventValidity.InvalidPre1970:
				// shouldn't happen while the check in setStartDate is still there, resetting the date each time
				throw new UserError("pre1970Start_msg")
			case CalendarEventValidity.Valid:
				return newEvent
		}
	}

	/**
	 * Keep in sync with _initializeNewEvent().
	 * @param newEvent the new event created from the CalendarEvent properties tracked in this class.
	 * @returns {boolean} true if changes were made to the event to justify sending updates to attendees.
	 */
	_hasChanges(newEvent: CalendarEvent): boolean {
		const existingEvent = this.existingEvent
		// we do not check for the sequence number (as it should be changed with every update) or the default instace properties such as _id
		return (
			!existingEvent ||
			newEvent.startTime.getTime() !== existingEvent.startTime.getTime() ||
			newEvent.description !== existingEvent.description ||
			newEvent.summary !== existingEvent.summary ||
			newEvent.location !== existingEvent.location ||
			newEvent.endTime.getTime() !== existingEvent.endTime.getTime() ||
			newEvent.invitedConfidentially !== existingEvent.invitedConfidentially ||
			newEvent.uid !== existingEvent.uid ||
			!areRepeatRulesEqual(newEvent.repeatRule, existingEvent.repeatRule) ||
			!arrayEqualsWithPredicate(
				newEvent.attendees,
				existingEvent.attendees,
				(a1, a2) => a1.status === a2.status && cleanMailAddress(a1.address.address) === cleanMailAddress(a2.address.address),
			) || // we ignore the names
			(newEvent.organizer !== existingEvent.organizer && newEvent.organizer?.address !== existingEvent.organizer?.address)
		) // we ignore the names
	}

	private addressToMailAddress(mailboxProperties: MailboxProperties, address: string): EncryptedMailAddress {
		return createEncryptedMailAddress({
			address,
			name: getSenderName(mailboxProperties, address) ?? "",
		})
	}

	/**
	 * completely delete all exclusions. will cause the event to be rendered and fire alarms on all
	 * occurrences as dictated by its repeat rule.
	 */
	deleteExcludedDates(): void {
		if (!this.repeat) return
		this.repeat.excludedDates.length = 0
	}
}

function areRepeatRulesEqual(r1: CalendarRepeatRule | null, r2: CalendarRepeatRule | null): boolean {
	return (
		r1 === r2 ||
		(r1?.endType === r2?.endType &&
			r1?.endValue === r2?.endValue &&
			r1?.frequency === r2?.frequency &&
			r1?.interval === r2?.interval &&
			r1?.timeZone === r2?.timeZone &&
			areExcludedDatesEqual(r1?.excludedDates ?? [], r2?.excludedDates ?? []))
	)
}

/**
 * compare two lists of dates that are sorted from earliest to latest. return true if they are equivalent.
 */
export function areExcludedDatesEqual(e1: ReadonlyArray<DateWrapper>, e2: ReadonlyArray<DateWrapper>): boolean {
	if (e1.length !== e2.length) return false
	return e1.every(({ date }, i) => e2[i].date.getTime() === date.getTime())
}

function createCalendarAlarm(identifier: string, trigger: string): AlarmInfo {
	const calendarAlarmInfo = createAlarmInfo()
	calendarAlarmInfo.alarmIdentifier = identifier
	calendarAlarmInfo.trigger = trigger
	return calendarAlarmInfo
}
