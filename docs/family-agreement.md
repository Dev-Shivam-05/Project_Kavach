# The Kavach family agreement

This is what we are installing, what it collects, who can see it, and what it
cannot do. Read it before you sign it. If a line here is not true in practice,
the system is wrong and we change the system — not this page.

Every adult signs. Every minor reads it and initials it. We read it again once a
year, together, and change whatever needs changing.

---

## 1. What this is

Kavach is a panic button and an alarm. You press it, or your phone detects a
crash or a fall, and it wakes the family: the phones ring, an SMS goes out with
your location, and a siren sounds.

**It is a second layer. It is not the first.**

> **This is not a substitute for calling 112. It may fail. It is a second layer,
> not the first.**

Say that sentence out loud once. It is the most important line on this page.

---

## 2. What each person's phone collects

| | What | Where it goes |
|---|---|---|
| **Your exact location** | GPS position, and where you have been | Encrypted. Our server stores it but **cannot read it**. Kept 90 days, then deleted. |
| **Your places** | Home, school, work, anywhere you mark | **Never leaves your phone.** The server never learns your home address. |
| **Your journeys** | The route you take on a trip you started | The route stays on your phone. The server knows only that a trip exists and when you should arrive. |
| **Your rough area** | A wide zone, roughly a few kilometres across | The server can read this. It is how we find the nearest family member during an emergency. |
| **Incidents** | That an alarm happened, what kind, when, who answered | The server can read this. Kept forever. |
| **Your phone's health** | Battery, whether the app is alive, whether it reached the network | The server can read this. Kept about 13 months. |
| **Your phone number** | | The server can read it. It is how the SMS fallback works. |
| **60 seconds of sound and motion** | Only during an alarm, only from your own phone, sealed and encrypted | Your phone. Nobody can turn this on for you remotely. Deleted 30 days after the incident ends. |
| **Medical card** | Blood group, allergies, medicines, emergency contacts — whatever you choose to put there | Encrypted. It shows on your own locked screen so a paramedic can read it. |
| **Screen time** | Which apps, how long — only if this is switched on for you | Your phone. Kept 90 days. It is yours. |

Three things nobody in this family gets, ever:

- **We do not read your messages.** Not WhatsApp, not SMS, not email.
- **We do not listen to your microphone.** The 60-second buffer records only
  during an alarm on your own phone, and only you can enable it for yourself.
- **We do not track which websites you visit.**

---

## 3. Who can see what

**A guardian is an administrator, not a watcher.** Being the person who set this
up does not mean seeing where you are. That takes your permission.

**Permission always expires.** There is no permanent one. Every grant has an end
date, and renewing is a deliberate act — not a checkbox somebody ticked once in
2026.

**You see every look.** Each time somebody opens your location, your phone
records it and shows it to you: who looked, when, and why. If that list is ever
empty when you know somebody looked, the system is broken and we fix it that
week.

**Permission is specific.** "You may see me during an emergency" is a different
permission from "you may see me on a normal Tuesday". Giving one does not give
the other.

### If you are under 18

Guardians can see a minor's location for safety and care without a separate
grant. That is what guardianship is. Two things stay true anyway:

- **You always see who looked and when.** Same as everyone else.
- **The rules loosen on a published schedule.** Here it is, so you can see it
  coming:

| Age | What changes |
|---|---|
| under 13 | Papa and Mummy can see where you are. You see an indicator saying so. |
| 13 | You can see exactly who looked at your location and when. |
| 15 | You can ask for a permission to expire; a guardian has to actively renew it, and you are told when they do. You get 2 hours a day of "private hours" — your location is blurred to about a kilometre and guardians are told private hours are on, not where you are. |
| 16 | You can switch off routine location entirely. Emergency location stays on. |
| 18 | You become an adult member. Every guardian permission ends automatically. |

---

## 4. What device management means

Some family phones are set up in a mode called **Device Owner**. This is real
power over the phone and you should know exactly what it is.

**Why:** Android phones kill background apps to save battery. A safety app that
has been killed is not a safety app. This mode is the only reliable way to stop
that happening.

**What is switched on now:**

| | What it means |
|---|---|
| The app cannot be uninstalled | Not from the app drawer, not from Settings. |
| The app's permissions cannot be revoked | Location, SMS, camera, microphone, phone state, Bluetooth, notifications, activity. It keeps them; Android cannot take them back after 90 days of not using them. |
| Safe mode is blocked | Safe mode is a phone with no Kavach running on it. |
| Adding a second user is blocked | A second user is the same phone and the same SIM with no alarm on it. |
| Reset protection is on | If the phone is wiped by a thief, it still needs a family account to set up again. |

**What is switched on later, after a month with no problems:**

| | What it means |
|---|---|
| Factory reset is blocked | The reset option disappears from Settings. |
| Developer/USB debugging is blocked | Applied last, on purpose — it is the last way to rescue a phone that has gone wrong. |

**What device management does NOT do here:**

- It does **not** read your messages, mail, photos or browsing.
- It does **not** turn on your microphone or camera.
- It does **not** block or suspend apps on an adult's phone. Ever.
- It does **not** hide itself. Android shows a "this device is managed" notice.
  We never try to hide that notice, and there is a screen in the app listing
  every restriction above, always reachable.

**Adults get less of it.** On an adult's phone we use the reliability half only:
permissions kept, app not removable. No app suspension. No kiosk mode.

**There is a way out.** A guardian can release a phone from management from
inside the app, which removes every restriction above. We built that before we
built any of the restrictions.

---

## 5. Cameras in the house

If a spare phone is ever used as a camera node:

- **Never in a bedroom or a bathroom.** The app refuses to set it up there.
  Recording either is a criminal offence, whoever owns the phone.
- **It switches itself off when anyone is home.** A house with people in it is
  not a place under surveillance.
- **Pictures are deleted after 7 days**, automatically.
- **Anyone can switch it off.** The off switch has no role check on it. You do
  not need to be a guardian.

---

## 6. Opting out, and what it costs

You can say no. Here is the honest price of each no, so you are deciding with
real information.

| If you switch off… | What you lose | What the family sees |
|---|---|---|
| Routine location | Nobody can see where you are day to day | Your name shows "routine location off" — not hidden, not secret |
| Emergency location | An alarm from your phone arrives **without a location**. Somebody must ring you to find out where you are. | Shown, and we will want to talk about it |
| Automatic crash/fall detection | The phone will not raise an alarm on its own if you are unconscious | Shown |
| The whole app | No panic button, no alarm, no family alert | Shown |

Nothing here is hidden from the family, in either direction. Someone quietly
switched off is the failure this system is supposed to prevent, and someone
quietly watched is the harm it is supposed to prevent. Both need to be visible.

You can withdraw a permission you gave, at any time, in one tap. You can ask for
your data to be deleted. Location history goes. Incident records do not — see
section 8.

---

## 7. What this system cannot do

Read this part twice.

- **It does not call the police or an ambulance.** No app in India can reliably
  do that. It puts a big CALL 112 button in front of a human, and a human has to
  press it. Your phone's own dialler sends your precise location to the
  emergency service automatically — ours cannot do that any better.
- **It may fail.** No network. Dead battery. Phone in a bag when it matters.
  Android killing it anyway. Our server down. SMS delayed by the carrier. Every
  one of these has happened to systems like this.
- **The alarm may not reach you.** Phones on silent, Do Not Disturb, face down
  in another room. We test this regularly and it still fails sometimes.
- **Automatic detection makes mistakes.** A dropped phone can look like a fall.
  We would rather ring you for nothing than miss something. If it rings for
  nothing too often, tell us — a detector nobody believes is worse than no
  detector.
- **It is not a reason to take a risk you would not otherwise take.** This is the
  one that actually gets people hurt.

We run a practice drill every three months. It takes four minutes. It is not
optional, because a system nobody has tested is decoration.

---

## 8. If someone leaves, or dies

**If you leave the family** — you move out, you turn 18 and want out, you simply
want to stop:

- Every permission you gave ends immediately.
- Your location history is deleted.
- Your phone is released from device management.
- Your medical card and documents go with you.
- **Incident records stay.** Records of alarms are kept by the family, because
  they are the account of what happened and they may matter legally. Deleting one
  needs two of the three guardians to agree.

**If a member dies:**

- Their location history is deleted after 90 days, like everyone's.
- Their incident records stay with the family.
- Their documents and medical records in the vault pass to whoever they named
  here: ______________________________. Say it now, in writing, because
  afterwards is a bad time to find out nobody knows.

**If the person who built this becomes unavailable:**

- Two guardians together can unlock the vault. Three recovery shares exist and
  any two of them work. They are held by ______________, ______________ and
  ______________, and they are stored apart from each other on purpose.
- We rehearse this recovery once a year. Twenty minutes, in the calendar. A
  recovery that has never been practised does not work, and you find that out on
  the worst possible day.

**If the family stops using Kavach entirely:** every phone is released from
management, the server data is deleted, and the vault is exported to whoever is
holding the shares.

---

## 9. What we promise each other

1. Nobody is watched without knowing.
2. Nobody is watched without being able to see who looked.
3. Every permission expires and has to be asked for again.
4. Administering this system is not the same as being allowed to watch people
   with it.
5. If this ever starts to feel like surveillance instead of safety, we say so,
   and we change it — the code is not the authority here.

---

## Signatures

We have read this. We understand what is collected, who can see it, what device
management does, and that this system can fail.

| Name | Role | Phone managed? | Signature | Date |
|---|---|---|---|---|
| | Guardian | Yes / No | | |
| | Guardian | Yes / No | | |
| | Adult member | Yes / No | | |
| | Adult member | Yes / No | | |
| | Adult member | Yes / No | | |

**Minors** — read with a guardian, initialled to say you understood it and that
you know the schedule in section 3:

| Name | Age | Initials | Date |
|---|---|---|---|
| | | | |
| | | | |

**Next review date:** ____________________ (one year from signing)

---

*Kavach — Project reference: PRD §20.3. The technical decisions behind the
promises on this page are in `docs/adr/`; the privacy ones are ADR-009,
ADR-010, ADR-015, ADR-019 and ADR-021.*
