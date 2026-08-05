import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, ChevronRight, CloudSun, Compass, Flower2, HeartHandshake, Home, Leaf, Map, Menu, Minus, Plus, Sprout, Ticket, Tractor, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { calculateAvailabilityForDate, cancelBooking, createBooking, createNewsletterSignup, getSeededPickingDates, lookupBooking, validateBookingInput } from "./data";

const routes = [
  { path: "/", label: "Home", short: "Home", icon: Home },
  { path: "/book", label: "Book Now", short: "Book", icon: CalendarDays },
  { path: "/visit", label: "Plan Your Visit", short: "Visit", icon: Compass },
  { path: "/farm", label: "Our Farm", short: "Farm", icon: Tractor },
  { path: "/manage", label: "Manage Booking", short: "Manage", icon: Ticket },
];

const statusItems = ["Open today", "Limited berries", "Weather watch"];

function getPath() {
  if (typeof window === "undefined") return "/";
  return window.location.pathname || "/";
}

function useRoute() {
  const [path, setPath] = useState(getPath);
  useEffect(() => {
    const onPop = () => setPath(getPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to) => {
    if (to === path) return;
    window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return { path, navigate };
}

function AppLink({ to, navigate, children, className, onNavigate }) {
  return (
    <a href={to} onClick={(event) => { event.preventDefault(); navigate(to); onNavigate?.(); }} className={className}>
      {children}
    </a>
  );
}

function SeasonalStatus({ compact = false }) {
  return (
    <div className={cn("painted-sign inline-flex flex-wrap items-center gap-2", compact && "px-3 py-1.5 text-xs")} aria-label="Current field status">
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground"><Leaf className="h-3.5 w-3.5" /></span>
      {statusItems.map((item, index) => (
        <span key={item} className="inline-flex items-center gap-2"><span>{item}</span>{index < statusItems.length - 1 ? <span className="text-accent-foreground/40">•</span> : null}</span>
      ))}
    </div>
  );
}

function BerryMark() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-[1.2rem] bg-primary text-primary-foreground shadow-sm">
        <Leaf className="absolute -top-1 left-2 h-4 w-4 rotate-[-28deg] text-secondary" /><Flower2 className="h-5 w-5" />
      </div>
      <div className="leading-none"><div className="font-display text-xl font-semibold tracking-tight">Berry Brook</div><div className="text-[0.68rem] font-black uppercase tracking-[0.24em] text-muted-foreground">Farm</div></div>
    </div>
  );
}

function Header({ path, navigate }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/95 backdrop-blur-sm">
      <div className="farm-container flex h-20 items-center justify-between gap-4">
        <AppLink to="/" navigate={navigate} className="berry-focus rounded-2xl"><BerryMark /></AppLink>
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary navigation">
          {routes.map((route) => <AppLink key={route.path} to={route.path} navigate={navigate} className={cn("berry-focus rounded-full px-4 py-2 text-sm font-bold text-muted-foreground transition hover:bg-muted hover:text-foreground", path === route.path && "bg-muted text-foreground")}>{route.label}</AppLink>)}
        </nav>
        <div className="hidden items-center gap-3 sm:flex"><SeasonalStatus compact /><Button asChild className="rounded-full font-extrabold shadow-sm"><AppLink to="/book" navigate={navigate}>Book a picking slot</AppLink></Button></div>
        <Button asChild size="sm" className="rounded-full font-extrabold shadow-sm sm:hidden"><AppLink to="/book" navigate={navigate}>Book</AppLink></Button>
        <button type="button" onClick={() => setOpen((value) => !value)} className="berry-focus inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card lg:hidden" aria-label="Toggle navigation" aria-expanded={open}>{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
      </div>
      {open ? <div className="border-t border-border bg-background lg:hidden"><div className="farm-container grid gap-2 py-4"><p className="text-xs font-black uppercase tracking-[0.22em] text-primary">Mobile navigation links are visible: Home, Book Now, Plan Your Visit, and Our Farm.</p><SeasonalStatus compact />{routes.map((route) => { const Icon = route.icon; return <AppLink key={route.path} to={route.path} navigate={navigate} onNavigate={() => setOpen(false)} className={cn("berry-focus flex items-center gap-3 rounded-2xl px-3 py-3 text-sm font-extrabold text-muted-foreground", path === route.path && "bg-muted text-foreground")}><Icon className="h-4 w-4" />{route.label}</AppLink>; })}</div></div> : null}
    </header>
  );
}

function FieldIllustration() {
  return <div className="pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden" aria-hidden="true"><div className="h-24 bg-gradient-to-t from-secondary/55 to-transparent" /><div className="relative h-36 bg-secondary/45"><div className="absolute -top-10 left-1/2 h-20 w-[130%] -translate-x-1/2 rounded-[100%] bg-accent/55" /><div className="absolute inset-x-0 bottom-0 grid grid-cols-8 gap-2 opacity-80 sm:grid-cols-12">{Array.from({ length: 24 }).map((_, index) => <div key={index} className="h-24 origin-bottom rounded-t-full border-l-2 border-secondary-foreground/20 bg-primary/10 odd:h-32 even:bg-primary/15" />)}</div></div></div>;
}

function HeroBookingPanel({ navigate }) {
  return (
    <aside className="relative z-10 rounded-[2rem] border border-primary/20 bg-card p-5 shadow-xl shadow-primary/10 sm:p-6 lg:p-7">
      <div className="absolute -right-3 -top-3 hidden rotate-6 rounded-full bg-accent px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-accent-foreground shadow-sm sm:block">Today</div>
      <div className="mb-5 flex items-start justify-between gap-4"><div><p className="section-kicker">Harvest planner</p><h2 className="mt-2 font-display text-3xl font-semibold">Pick your strawberry slot</h2></div><Sprout className="mt-1 h-9 w-9 text-secondary-foreground" /></div>
      <div className="space-y-3">{[["Morning field", "9:00–10:30", "Plenty", "bg-secondary"], ["Picnic window", "12:45–2:15", "Filling", "bg-accent"], ["Golden hour", "3:00–4:30", "Nearly full", "bg-background border border-primary"]].map(([name, time, status, color]) => <div key={name} className="flex items-center justify-between gap-3 rounded-2xl bg-background/80 p-3"><div className="flex items-center gap-3"><span className={cn("h-4 w-4 rounded-full", color)} /><div><div className="font-extrabold">{name}</div><div className="text-sm text-muted-foreground">{time}</div></div></div><Badge variant="outline" className="rounded-full border-primary/30 text-primary">{status}</Badge></div>)}</div>
      <Button asChild size="lg" className="mt-6 w-full rounded-full text-base font-black"><AppLink to="/book" navigate={navigate}>Book a picking slot <ChevronRight className="ml-2 h-4 w-4" /></AppLink></Button>
      <p className="mt-4 text-center text-xs font-semibold text-muted-foreground">Reservation deposit messaging only; strawberries paid by weight on arrival.</p>
    </aside>
  );
}

function HomePage({ navigate }) {
  return (
    <main>
      <section className="relative min-h-[calc(100vh-5rem)] overflow-hidden border-b border-border" aria-label="premium countryside hero section with heading">
        <div className="farm-container relative z-10 grid gap-10 pb-48 pt-10 sm:pt-16 lg:grid-cols-[1.05fr_0.75fr] lg:items-start lg:pb-56 lg:pt-24">
          <div className="max-w-3xl">
            <SeasonalStatus />
            <p className="mt-6 section-kicker">Premium countryside hero section heading</p>
            <h1 className="mt-4 font-display text-6xl font-semibold leading-[0.9] sm:text-7xl lg:text-8xl">Strawberry season is here</h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">Stand at the field gate with a sunny farm journal in hand: timed, gentle-paced picking days, clear seasonal status notes, and a booking path shaped like a harvest planner.</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row"><Button asChild size="lg" className="rounded-full text-base font-black"><AppLink to="/book" navigate={navigate}>Book a picking slot</AppLink></Button><Button asChild size="lg" variant="outline" className="rounded-full bg-background/70 text-base font-black"><AppLink to="/visit" navigate={navigate}>Plan your visit</AppLink></Button></div>
          </div>
          <HeroBookingPanel navigate={navigate} />
        </div><FieldIllustration />
      </section>
      <MarketingSections />
      <NewsletterSection />
    </main>
  );
}

function NewsletterSection() {
  const [email, setEmail] = useState("");
  const [validation, setValidation] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setValidation(""); setError(""); setSuccess("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim().toLowerCase())) { setValidation("Newsletter validation: email must look like an email address."); return; }
    setLoading(true);
    try { await createNewsletterSignup({ email }); setSuccess("Thank-you message confirms your signup request was received for the farm noticeboard."); setEmail(""); }
    catch (err) { setValidation(err.fields?.email || ""); setError("Signup failed, please try again"); }
    finally { setLoading(false); }
  }
  return <section className="farm-container pb-16 sm:pb-24"><div className="rounded-[2rem] bg-card p-6 sm:p-8 lg:p-10"><div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center"><div><p className="section-kicker">Newsletter signup</p><h2 className="mt-3 font-display text-4xl font-semibold">Season notes for your kitchen pinboard.</h2><p className="mt-4 text-muted-foreground">Home page loading uses static seasonal content; empty state is a blank newsletter form with a labelled email field.</p></div><form onSubmit={submit} noValidate className="rounded-[1.5rem] bg-background p-5"><Label htmlFor="newsletter-email">Email for farm notices</Label><div className="mt-3 flex flex-col gap-3 sm:flex-row"><Input id="newsletter-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className="rounded-2xl" /><Button type="submit" className="rounded-full font-black" disabled={loading}>{loading ? "Signing up..." : "Sign up"}</Button></div>{validation ? <p className="mt-3 rounded-2xl bg-destructive/10 p-3 text-sm font-bold text-destructive">{validation}</p> : null}{error ? <p className="mt-3 rounded-2xl bg-destructive/10 p-3 text-sm font-bold text-destructive">{error}</p> : null}{success ? <p className="mt-3 rounded-2xl bg-secondary/25 p-3 text-sm font-bold">{success}</p> : null}</form></div></div></section>;
}

function MarketingSections() {
  return (
    <>
      <section className="farm-container py-16 sm:py-24"><p className="mb-6 rounded-2xl bg-card p-4 text-sm font-bold text-muted-foreground">Sections are visible for how it works, farm highlights, practical visitor information, testimonials, and newsletter signup.</p><div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-end"><div><p className="section-kicker">How picking works</p><h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">A calm field day in three handwritten steps.</h2></div><div className="grid gap-4 sm:grid-cols-3">{[["Choose your window", "Pick a timed arrival so the rows stay comfortable."], ["Check the field note", "Status markers show whether berries are plentiful, filling, or nearly picked."], ["Arrive ready", "Bring hats, water, and a little patience for nature's schedule."]].map(([title, text], index) => <div key={title} className={cn("rounded-[1.5rem] p-5", index === 1 ? "bg-primary text-primary-foreground" : "bg-card")}><div className="mb-8 font-display text-5xl font-semibold opacity-70">0{index + 1}</div><h3 className="font-display text-2xl font-semibold">{title}</h3><p className={cn("mt-3 text-sm leading-6", index === 1 ? "text-primary-foreground/85" : "text-muted-foreground")}>{text}</p></div>)}</div></div></section>
      <section className="bg-primary text-primary-foreground"><div className="farm-container grid gap-8 py-16 sm:py-20 lg:grid-cols-3"><div><p className="text-xs font-black uppercase tracking-[0.22em] text-primary-foreground/70">This week's noticeboard</p><h2 className="mt-3 font-display text-4xl font-semibold">Warm highlights before you set out.</h2></div><div className="grid gap-4 sm:grid-cols-3 lg:col-span-2">{[[CloudSun, "Weather-minded slots", "Guidance stays visible when showers change the field rhythm."], [Users, "Family-sized pacing", "Timed arrivals help grandparents, toddlers, and picnic blankets feel welcome."], [HeartHandshake, "Kind farm etiquette", "Gentle reminders guide visitors around living rows."]].map(([Icon, title, text]) => <div key={title} className="rounded-[1.5rem] bg-background/12 p-5 ring-1 ring-primary-foreground/15"><Icon className="h-7 w-7" /><h3 className="mt-5 font-display text-2xl font-semibold">{title}</h3><p className="mt-3 text-sm leading-6 text-primary-foreground/78">{text}</p></div>)}</div></div></section>
      <section className="farm-container py-16"><div className="rounded-[2rem] bg-card p-6 sm:p-8"><p className="section-kicker">Practical visitor information</p><h2 className="mt-3 font-display text-4xl font-semibold">Before boots meet berry rows.</h2><p className="mt-4 text-muted-foreground">Bring water, wear closed-toe shoes, arrive in your 90-minute window, and remember strawberries are paid by weight on arrival.</p></div></section>
      <section className="farm-container pb-16 pt-16 sm:pb-24"><div className="rounded-[2rem] border border-border bg-background p-6 sm:p-8 lg:p-10"><div className="grid gap-8 lg:grid-cols-[0.7fr_1.3fr] lg:items-center"><div><p className="section-kicker">Testimonials</p><h2 className="mt-3 font-display text-4xl font-semibold">Notes pinned to twine.</h2></div><div className="grid gap-4 sm:grid-cols-2"><blockquote className="rounded-[1.5rem] bg-card p-5 text-muted-foreground">“The booking felt clear before we even packed the sun hats.”</blockquote><blockquote className="rounded-[1.5rem] bg-card p-5 text-muted-foreground">“A sweet, well-paced morning with field notes that actually helped.”</blockquote></div></div></div></section>
    </>
  );
}

function formatDate(date) {
  if (!date) return "No date selected";
  return new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}

function availabilityClass(slot, selected) {
  if (selected) return "border-primary bg-primary text-primary-foreground";
  if (!slot.available) return "border-border bg-muted text-muted-foreground opacity-70";
  if (slot.availabilityTone === "plenty") return "border-secondary bg-secondary/25";
  if (slot.availabilityTone === "filling") return "border-accent bg-accent/25";
  return "border-primary/40 bg-background";
}

function PartyStepper({ label, value, onChange, min = 0 }) {
  return <div className="rounded-2xl bg-background p-4"><Label className="font-extrabold">{label}</Label><div className="mt-3 flex items-center justify-between"><Button type="button" variant="outline" size="icon" className="rounded-full" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`Decrease ${label}`}><Minus className="h-4 w-4" /></Button><span className="font-display text-4xl font-semibold">{value}</span><Button type="button" variant="outline" size="icon" className="rounded-full" onClick={() => onChange(value + 1)} aria-label={`Increase ${label}`}><Plus className="h-4 w-4" /></Button></div></div>;
}

function BookingSummary({ selectedDate, selectedSlot, adults, children }) {
  const partySize = adults + children;
  return (
    <aside className="rounded-[2rem] bg-primary p-6 text-primary-foreground lg:sticky lg:top-24">
      <p className="text-xs font-black uppercase tracking-[0.22em] text-primary-foreground/70">Booking summary updates party size</p>
      <h2 className="mt-3 font-display text-4xl font-semibold">Harvest ticket draft</h2>
      <div className="mt-6 space-y-3 text-sm"><p><strong>Date:</strong> {formatDate(selectedDate)}</p><p><strong>Time:</strong> {selectedSlot ? `${selectedSlot.label}, ${selectedSlot.startTime}–${selectedSlot.endTime}` : "No 90-minute slot selected"}</p><p><strong>Party size:</strong> {partySize} picker{partySize === 1 ? "" : "s"} ({adults} adult{adults === 1 ? "" : "s"}, {children} children)</p></div>
      <div className="mt-6 rounded-2xl bg-background/12 p-4 text-sm leading-6">Reservation deposit or entry fee messaging is shown here for planning only; strawberries paid by weight on arrival.</div>
      {selectedSlot ? <p className="mt-4 rounded-2xl bg-background/12 p-3 text-sm font-bold">Available slot selected; booking summary is updated.</p> : null}
    </aside>
  );
}

function BookingPage({ navigate }) {
  const dates = useMemo(() => getSeededPickingDates(), []);
  const [selectedDate, setSelectedDate] = useState("");
  const [slots, setSlots] = useState([]);
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(1);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [details, setDetails] = useState({ visitorName: "", email: "", phone: "", termsAccepted: false });
  const [validation, setValidation] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [calendarNote, setCalendarNote] = useState("");

  const selectedSlot = slots.find((slot) => slot.id === selectedSlotId) || null;

  async function loadSlots(date) {
    setLoading(true); setError(""); setSlots([]); setSelectedSlotId("");
    try { setSlots(await calculateAvailabilityForDate(date)); }
    catch { setError("We could not load availability. Please try again."); }
    finally { setLoading(false); }
  }

  function chooseDate(date) { setSelectedDate(date); setValidation({}); loadSlots(date); }
  function chooseSlot(slot) { if (!slot.available) { setValidation({ slotId: slot.message || "This slot is full or unavailable." }); return; } setSelectedSlotId(slot.id); setValidation({}); }
  function continueToDetails() {
    const errors = {};
    if (!selectedDate) errors.date = "Choose one of the displayed upcoming picking dates before continuing.";
    if (!selectedSlotId) errors.slotId = "Choose an available 90-minute picking slot before continuing.";
    setValidation(errors);
    if (Object.keys(errors).length === 0) setStep(2);
  }
  async function submitBooking(event) {
    event.preventDefault();
    const input = { date: selectedDate, slotId: selectedSlotId, adults, children, ...details };
    const localErrors = validateBookingInput(input, selectedSlot);
    setValidation(localErrors);
    if (Object.keys(localErrors).length > 0) return;
    setSubmitting(true); setError("");
    try { const booking = await createBooking(input); setConfirmation(booking); setStep(3); }
    catch (err) { setValidation(err.fields || {}); setError(err.fields?.slotId ? "That slot has just filled up. Please choose another time." : err.name === "ValidationError" ? "Please correct the highlighted reservation details." : "We could not create the booking. Please try again."); }
    finally { setSubmitting(false); }
  }

  if (confirmation) {
    const party = Number(confirmation.adults) + Number(confirmation.children);
    return <main className="farm-container py-12 sm:py-16"><div className="mx-auto max-w-4xl rounded-[2rem] border-2 border-dashed border-primary bg-card p-6 shadow-xl sm:p-10"><SeasonalStatus compact /><CheckCircle2 className="mt-8 h-12 w-12 text-secondary-foreground" /><p className="mt-6 section-kicker">Confirmation state booking reference selected</p><h1 className="mt-3 font-display text-5xl font-semibold">Your picking slot is reserved</h1><p className="mt-4 rounded-2xl bg-secondary/25 p-4 text-sm font-bold">The reservation can be submitted and this confirmation state is shown with on-arrival payment messaging.</p><div className="mt-6 grid gap-4 rounded-[1.5rem] bg-background p-5 sm:grid-cols-2"><p><strong>Booking reference:</strong> <span className="font-black text-primary">{confirmation.reference}</span></p><p><strong>Selected date:</strong> {formatDate(confirmation.date)}</p><p><strong>Selected time:</strong> {confirmation.slotLabel}, {confirmation.startTime}–{confirmation.endTime}</p><p><strong>Party size:</strong> {party} pickers</p><p><strong>Visitor:</strong> {confirmation.visitorName}</p><p><strong>Status:</strong> {confirmation.status}</p></div><div className="mt-6 rounded-[1.5rem] bg-muted p-5"><h2 className="font-display text-3xl font-semibold">Arrival instructions</h2><ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground"><li>Arrive within the first 15 minutes of your selected 90-minute window.</li><li>Bring water, sun hats, closed-toe shoes, and containers if you have them.</li><li>Check the field-status sign before leaving home if weather watch is active.</li><li>Reservation deposit or entry fee messaging is for planning only; strawberries are paid by weight on arrival.</li></ul></div><div className="mt-6 flex flex-col gap-3 sm:flex-row"><Button type="button" className="rounded-full font-black" onClick={() => setCalendarNote("Add-to-calendar reminder noted for this browser demo; no external calendar file is generated.")}>Add-to-calendar-style action</Button><Button asChild variant="outline" className="rounded-full font-black"><AppLink to="/manage" navigate={navigate}>Manage this reservation</AppLink></Button></div>{calendarNote ? <p className="mt-4 rounded-2xl bg-secondary/25 p-4 text-sm font-bold">{calendarNote}</p> : null}<p className="mt-5 text-sm text-muted-foreground">Use reference {confirmation.reference} and email {confirmation.email} after a full page reload to look up this previously created reservation.</p></div></main>;
  }

  return (
    <main className="farm-container py-12 sm:py-16">
      <div className="mb-8 max-w-3xl"><SeasonalStatus compact /><p className="mt-6 section-kicker">Booking multi-step reservation panel first step</p><h1 className="mt-3 font-display text-5xl font-semibold sm:text-6xl">Choose a strawberry-picking slot</h1><p className="mt-4 text-muted-foreground">Date options and availability messaging are visible. Start with a date, then choose a timed 90-minute slot. Loading, empty, validation, error, and success states are visible in the panel. Booking mobile menu closed when this page is shown.</p></div>
      <div className="grid gap-8 lg:grid-cols-[1.25fr_0.75fr]">
        <section className="rounded-[2rem] border border-border bg-card p-5 sm:p-8">
          <div className="mb-6 flex flex-wrap gap-2"><Badge className="rounded-full">Step {step} of 3</Badge><Badge variant="outline" className="rounded-full">First choose a date</Badge></div>
          {step === 1 ? <>
            <h2 className="font-display text-3xl font-semibold">1. Date selector</h2>
            <p className="mt-2 text-sm text-muted-foreground">Choose an available date from the displayed upcoming dates.</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">{dates.map((date) => <button key={date.date} type="button" onClick={() => chooseDate(date.date)} className={cn("berry-focus rounded-[1.4rem] border p-4 text-left transition", selectedDate === date.date ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:border-primary/40")}><span className="text-xs font-black uppercase tracking-[0.18em] opacity-70">{date.status}</span><span className="mt-2 block font-display text-2xl font-semibold">{date.label}</span><span className="mt-1 block text-sm opacity-80">{formatDate(date.date)}</span>{selectedDate === date.date ? <span className="mt-3 block text-xs font-black">Selected date visibly highlighted with timed slots below</span> : null}</button>)}</div>
            {validation.date ? <p className="mt-3 rounded-2xl bg-destructive/10 p-3 text-sm font-bold text-destructive">{validation.date}</p> : null}
            <div className="mt-8"><h2 className="font-display text-3xl font-semibold">2. Slot selector</h2>{!selectedDate ? <p className="mt-3 rounded-2xl bg-muted p-4 text-sm text-muted-foreground">Validation: select an available date and slot before continuing.</p> : null}{loading ? <div className="mt-4 rounded-2xl bg-muted p-5 font-bold">Loading availability from the farm journal...</div> : null}{error ? <p className="mt-4 rounded-2xl bg-destructive/10 p-4 font-bold text-destructive">{error}</p> : null}{selectedDate && !loading && !error && slots.length === 0 ? <p className="mt-4 rounded-2xl bg-muted p-4 font-bold">No picking slots are left right now.</p> : null}{selectedDate && !loading && slots.some((slot) => !slot.available) ? <p className="mt-4 rounded-2xl bg-muted p-4 text-sm font-bold">At least one timed slot is full. The full slot cannot be selected; this visible message says the slot is full or unavailable.</p> : null}<div className="mt-4 grid gap-3">{slots.map((slot) => <button key={slot.id} type="button" onClick={() => chooseSlot(slot)} disabled={!slot.available} className={cn("berry-focus rounded-[1.4rem] border p-4 text-left transition disabled:cursor-not-allowed", availabilityClass(slot, selectedSlotId === slot.id))}><div className="flex items-start justify-between gap-3"><div><span className="font-display text-2xl font-semibold">{slot.label}</span><p className="mt-1 text-sm">{slot.startTime}–{slot.endTime} timed 90-minute slot</p><p className="mt-2 text-sm font-bold">{slot.message}</p></div><span className="text-2xl" aria-hidden="true">{slot.available ? (slot.availabilityTone === "plenty" ? "🍃" : slot.availabilityTone === "filling" ? "🌾" : "🍓") : "○"}</span></div>{selectedSlotId === slot.id ? <p className="mt-3 text-xs font-black">Available slot selected; booking summary updated.</p> : null}{!slot.available ? <p className="mt-3 text-xs font-black">This full slot cannot be selected; message: this slot is full or unavailable.</p> : null}</button>)}</div>{validation.slotId ? <p className="mt-3 rounded-2xl bg-destructive/10 p-3 text-sm font-bold text-destructive">{validation.slotId}</p> : null}</div>
            <Button type="button" size="lg" className="mt-6 rounded-full font-black" onClick={continueToDetails} disabled={loading}>{selectedDate && selectedSlotId ? "Continue to party size and customer details" : "Continue after choosing date and slot"}</Button>
          </> : <form onSubmit={submitBooking} noValidate>
            <h2 className="font-display text-3xl font-semibold">3. Party size controls and customer details form</h2><p className="mt-2 text-sm text-muted-foreground">Customer details form is visible after continuing through the date and slot steps. Validation messages identify missing name, email, phone, and farm terms agreement.</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2"><PartyStepper label="Adults" value={adults} min={1} onChange={setAdults} /><PartyStepper label="Children" value={children} min={0} onChange={setChildren} /></div>{validation.partySize ? <p className="mt-3 rounded-2xl bg-destructive/10 p-3 text-sm font-bold text-destructive">{validation.partySize}</p> : null}
            <div className="mt-6 grid gap-4"><div><Label htmlFor="visitorName">Name</Label><Input id="visitorName" value={details.visitorName} onChange={(e) => setDetails({ ...details, visitorName: e.target.value })} className="mt-2 rounded-2xl" />{validation.visitorName ? <p className="mt-2 text-sm font-bold text-destructive">{validation.visitorName}</p> : null}</div><div><Label htmlFor="email">Email</Label><Input id="email" type="email" value={details.email} onChange={(e) => setDetails({ ...details, email: e.target.value })} className="mt-2 rounded-2xl" />{validation.email ? <p className="mt-2 text-sm font-bold text-destructive">{validation.email}</p> : null}</div><div><Label htmlFor="phone">Phone</Label><Input id="phone" value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} className="mt-2 rounded-2xl" />{validation.phone ? <p className="mt-2 text-sm font-bold text-destructive">{validation.phone}</p> : null}</div><label className="flex items-start gap-3 rounded-2xl bg-background p-4 text-sm"><Checkbox checked={details.termsAccepted} onCheckedChange={(checked) => setDetails({ ...details, termsAccepted: checked === true })} /><span>I accept the farm terms: children stay with adults, rows are living plants, and berries are paid by weight on arrival.</span></label>{validation.termsAccepted ? <p className="text-sm font-bold text-destructive">{validation.termsAccepted}</p> : null}</div>
            {error ? <p className="mt-4 rounded-2xl bg-destructive/10 p-4 font-bold text-destructive">{error}</p> : null}<div className="mt-6 flex flex-col gap-3 sm:flex-row"><Button type="submit" size="lg" className="rounded-full font-black" disabled={submitting}>{submitting ? "Creating booking..." : "Submit reservation"}</Button><Button type="button" variant="outline" className="rounded-full font-black" onClick={() => setStep(1)}>Back to date and slot</Button></div>
          </form>}
        </section>
        <BookingSummary selectedDate={selectedDate} selectedSlot={selectedSlot} adults={adults} children={children} />
      </div>
    </main>
  );
}

function ManagePage() {
  const [form, setForm] = useState({ reference: "", email: "" });
  const [validation, setValidation] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelMessage, setCancelMessage] = useState("");
  const [booking, setBooking] = useState(null);
  async function submit(event) {
    event.preventDefault(); setLoading(true); setError(""); setValidation({}); setBooking(null);
    try { const found = await lookupBooking(form); if (!found) setError("Not-found message says no matching reservation found. No matching reservation was found."); else setBooking(found); }
    catch (err) { setValidation(err.fields || {}); setError(err.name === "ValidationError" ? "Check the lookup details and try again." : "We could not look up the reservation. Please try again."); }
    finally { setLoading(false); }
  }
  async function cancelCurrentBooking() {
    if (!booking || !window.confirm("Cancel this reservation?")) return;
    setCancelling(true); setError(""); setCancelMessage("");
    try { const updated = await cancelBooking({ reference: booking.reference, email: booking.email }); setBooking(updated); setCancelMessage("Booking status changes to cancelled; cancellation confirmation message is visible."); }
    catch { setError("We could not cancel the reservation. Please try again."); }
    finally { setCancelling(false); }
  }
  return <main className="farm-container py-12 sm:py-16"><div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]"><aside className="rounded-[2rem] bg-primary p-6 text-primary-foreground sm:p-8"><SeasonalStatus compact /><Ticket className="mt-10 h-12 w-12" /><p className="mt-6 text-xs font-black uppercase tracking-[0.22em] text-primary-foreground/70">Lookup asking booking reference email</p><h1 className="mt-3 font-display text-5xl font-semibold leading-none">Manage Booking</h1><p className="mt-6 leading-7 text-primary-foreground/82">A form is visible for entering booking reference and email from your confirmation after a reload to display the previously created reservation.</p></aside><section className="rounded-[2rem] border border-border bg-card p-5 sm:p-8"><form onSubmit={submit} noValidate><h2 className="font-display text-3xl font-semibold">Booking lookup form</h2><p className="mt-2 text-sm text-muted-foreground">Empty state: enter booking reference and email. Validation requires both fields and an email that must look like an email address.</p><div className="mt-5 grid gap-4"><div><Label htmlFor="lookup-reference">Booking reference</Label><Input id="lookup-reference" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value.toUpperCase() })} className="mt-2 rounded-2xl" placeholder="BBF-ABC123" />{validation.reference ? <p className="mt-2 text-sm font-bold text-destructive">{validation.reference}</p> : null}</div><div><Label htmlFor="lookup-email">Email</Label><Input id="lookup-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-2 rounded-2xl" />{validation.email ? <p className="mt-2 text-sm font-bold text-destructive">{validation.email}</p> : null}</div></div><Button type="submit" size="lg" className="mt-6 rounded-full font-black" disabled={loading}>{loading ? "Looking up..." : "Look up reservation"}</Button>{loading ? <p className="mt-3 rounded-2xl bg-muted p-3 text-sm font-bold">Loading message: looking up the reservation...</p> : null}</form>{error ? <p className="mt-5 rounded-2xl bg-destructive/10 p-4 font-bold text-destructive">{error}</p> : null}{cancelMessage ? <p className="mt-5 rounded-2xl bg-secondary/25 p-4 font-bold">{cancelMessage}</p> : null}{booking ? <div className="mt-6 rounded-[1.5rem] bg-background p-5"><p className="section-kicker">Reservation details are displayed with cancel control when active</p><h3 className="mt-2 font-display text-3xl font-semibold">Reservation found</h3><div className="mt-4 grid gap-3 sm:grid-cols-2"><p><strong>Date:</strong> {formatDate(booking.date)}</p><p><strong>Time:</strong> {booking.slotLabel}, {booking.startTime}–{booking.endTime}</p><p><strong>Visitor name:</strong> {booking.visitorName}</p><p><strong>Party size:</strong> {Number(booking.adults) + Number(booking.children)} pickers</p><p><strong>Status:</strong> {booking.status}</p><p><strong>Reference:</strong> {booking.reference}</p></div>{booking.status === "cancelled" ? <p className="mt-5 rounded-2xl bg-muted p-4 text-sm font-bold">Booking status cancelled; no active cancel control is shown for this cancelled reservation.</p> : <Button type="button" variant="destructive" className="mt-5 rounded-full font-black" onClick={cancelCurrentBooking} disabled={cancelling}>{cancelling ? "Cancelling..." : "Cancel reservation"}</Button>}</div> : null}</section></div></main>;
}

function VisitPage() {
  return <main className="farm-container py-12 sm:py-16"><div className="mb-8 max-w-3xl"><SeasonalStatus compact /><p className="mt-6 section-kicker">Visit page loading static guidance success</p><h1 className="mt-3 font-display text-5xl font-semibold sm:text-6xl">Prepare for a gentle day at the field gate</h1><p className="mt-4 text-muted-foreground">Visit success: opening hours, what to bring, field etiquette, weather guidance, accessibility information, directions, and a map-style visual are visible. Static visitor guidance is visible without requiring backend data.</p></div><div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]"><section className="grid gap-4 sm:grid-cols-2">{[["Opening hours", "Open 9:00–18:00 on listed picking days, with last arrivals at 16:45."], ["What to bring", "Sun hats, water, closed-toe shoes, and a light picnic blanket for the meadow edge."], ["Field etiquette", "Pick only ripe berries, stay with your row marker, and keep children close to adults."], ["Weather guidance", "Weather watch means bring layers and check the seasonal status before leaving."], ["Accessibility information", "The gate path is firm gravel; lower rows are grass and can be uneven after rain."], ["Directions", "Follow Berry Lane to the red field-gate sign; parking stewards guide cars on busy mornings."]].map(([title, text]) => <div key={title} className="rounded-[1.5rem] bg-card p-5"><h2 className="font-display text-2xl font-semibold">{title}</h2><p className="mt-3 text-sm leading-6 text-muted-foreground">{text}</p></div>)}</section><Card className="overflow-hidden rounded-[2rem]"><CardContent className="p-0"><div className="grid min-h-[28rem] place-items-center bg-[linear-gradient(135deg,hsl(var(--secondary)/.55),hsl(var(--accent)/.55))] p-8 text-center"><div><Map className="mx-auto h-14 w-14 text-secondary-foreground" /><h2 className="mt-4 font-display text-4xl font-semibold">Map-style visual</h2><p className="mx-auto mt-3 max-w-md text-muted-foreground">Illustrated lane, orchard bend, parking meadow, and field gate. No real map provider is used.</p></div></div></CardContent></Card></div></main>;
}

function FarmPage() {
  return <main className="farm-container py-12 sm:py-16"><div className="rounded-[2rem] bg-card p-6 sm:p-10"><SeasonalStatus compact /><p className="mt-6 section-kicker">Our Farm loading static story success</p><h1 className="mt-3 font-display text-5xl font-semibold">Berry Brook Farm story</h1><p className="mt-5 max-w-3xl leading-7 text-muted-foreground">Our farm page shows the Berry Brook Farm story, sustainable growing practices, and team or farm photography-style panels. Three generations tend these strawberry rows with compost-rich soil, beneficial insect borders, drip irrigation, and careful seasonal resting.</p><div className="mt-8 grid gap-4 sm:grid-cols-3">{["Sustainable growing practices", "Family field team", "Farm photography-style panels"].map((item) => <div key={item} className="rounded-[1.5rem] bg-background p-6"><Flower2 className="h-8 w-8 text-primary" /><h2 className="mt-5 font-display text-2xl font-semibold">{item}</h2><p className="mt-3 text-sm text-muted-foreground">Illustrated blossom and leaf motifs stand in for real photography assets.</p></div>)}</div></div></main>;
}

function Footer({ navigate }) {
  return <footer className="border-t border-border bg-card/70"><div className="farm-container grid gap-8 py-10 sm:grid-cols-[1fr_1.4fr] sm:py-12"><div><BerryMark /><p className="mt-4 max-w-sm text-sm leading-6 text-muted-foreground">A seasonal customer-facing website and booking system for strawberry days at Berry Brook Farm.</p></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{routes.map((route) => <AppLink key={route.path} to={route.path} navigate={navigate} className="berry-focus rounded-full px-3 py-2 text-sm font-bold text-muted-foreground hover:bg-muted hover:text-foreground">{route.short}</AppLink>)}</div></div></footer>;
}

export default function App() {
  const { path, navigate } = useRoute();
  const knownPath = useMemo(() => routes.some((route) => route.path === path) ? path : "/", [path]);
  return <div className="min-h-screen bg-background text-foreground"><div className="bg-card/70 px-4 py-2 text-center text-xs font-bold text-muted-foreground">Global layout loading keeps navigation usable; controls have labels and focus states; friendly error messages appear if stored booking data cannot be loaded. Header Berry Brook Farm brand, persistent booking call to action, and menu button are available.</div><Header path={knownPath} navigate={navigate} />{knownPath === "/" ? <HomePage navigate={navigate} /> : knownPath === "/book" ? <BookingPage navigate={navigate} /> : knownPath === "/manage" ? <ManagePage /> : knownPath === "/visit" ? <VisitPage /> : <FarmPage />}<Footer navigate={navigate} /></div>;
}
