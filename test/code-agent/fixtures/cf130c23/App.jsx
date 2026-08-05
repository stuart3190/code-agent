import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Car, CheckCircle2, ChevronRight, Clock, HeartHandshake, Leaf, Mail, MapPin, Menu, Minus, Plus, Sprout, Sun, TicketCheck, Umbrella, Users, Wheat, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { auth } from "@/lib/backend";
import { BOOKING_STATUS, cancelBooking, createBooking, getSlotAvailability, readBookingByReferenceEmail, PICKING_DATES } from "./data/booking";
import { createNewsletterSignup } from "./data/newsletterSignup";

const ROUTES = {
  "/": "Home",
  "/book": "Book a picking slot",
  "/booking/manage": "Manage booking",
  "/visit": "Plan your visit",
  "/our-farm": "Our Farm",
};

const NAV_ITEMS = [
  { path: "/", label: "Season" },
  { path: "/visit", label: "Plan your visit" },
  { path: "/our-farm", label: "Our farm" },
  { path: "/booking/manage", label: "Manage booking" },
];

const highlights = [
  { icon: Sprout, title: "Pick at field pace", copy: "Arrival windows are spaced so families have room along the orchard rows." },
  { icon: CalendarDays, title: "Reserve a slot", copy: "Choose a date and timed entry before heading out to the farm gate." },
  { icon: Leaf, title: "Pay by weight", copy: "No deposit in the foundation experience: berries are weighed and paid for on arrival day." },
];

const visitorNotes = [
  "Wear comfortable shoes for uneven ground.",
  "Bring water, sun hats and a small picnic blanket.",
  "Check our static weather guidance before leaving home.",
];

const DATE_LABELS = Object.fromEntries(PICKING_DATES.map((date) => [date.date, date.longLabel]));

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function StateNote({ tone = "info", children, className }) {
  const tones = {
    info: "bg-background text-muted-foreground",
    success: "bg-secondary text-secondary-foreground",
    warn: "bg-accent text-foreground",
    error: "bg-primary/10 text-primary",
  };
  return <p className={cn("rounded-2xl p-4 font-semibold leading-6", tones[tone], className)}>{children}</p>;
}

async function ensureBookingSession() {
  const existing = await auth.currentUser();
  if (existing) return existing;
  const key = "berry-brook-visitor-session";
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    saved = null;
  }
  if (!saved?.email || !saved?.password) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    saved = { email: `visitor-${id}@berrybrook.local`, password: `BerryBrook-${id}-visitor` };
    localStorage.setItem(key, JSON.stringify(saved));
  }
  try {
    return await auth.signIn(saved);
  } catch {
    return auth.signUp(saved);
  }
}

function navigateTo(path) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname || "/");

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return ROUTES[path] ? path : "/";
}

function LinkButton({ to, children, className, variant = "ghost", size = "default" }) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={() => navigateTo(to)}
    >
      {children}
    </Button>
  );
}

function FarmMark({ small = false }) {
  return (
    <div className={cn("relative grid place-items-center rounded-full bg-primary text-primary-foreground", small ? "h-9 w-9" : "h-11 w-11")}>
      <span className={cn("font-display font-semibold", small ? "text-lg" : "text-2xl")}>B</span>
      <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-accent" aria-hidden="true" />
    </div>
  );
}

function AppShell({ route, children }) {
  const [open, setOpen] = useState(false);

  const title = useMemo(() => ROUTES[route] || ROUTES["/"], [route]);
  useEffect(() => {
    document.title = `${title} · Berry Brook Farm`;
  }, [title]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => navigateTo("/")}
            className="flex min-w-0 items-center gap-3 rounded-full text-left focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
            aria-label="Berry Brook Farm home"
          >
            <FarmMark />
            <span className="min-w-0">
              <span className="block font-display text-xl font-semibold leading-5">Berry Brook</span>
              <span className="block text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Strawberry Farm</span>
            </span>
          </button>

          <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.path}
                type="button"
                onClick={() => navigateTo(item.path)}
                className={cn(
                  "rounded-full px-4 py-2 text-sm font-semibold transition hover:bg-secondary/70 focus:outline-none focus:ring-2 focus:ring-ring",
                  route === item.path ? "bg-secondary text-secondary-foreground" : "text-muted-foreground"
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="hidden items-center gap-2 sm:flex">
            <LinkButton to="/book" variant="default" className="rounded-full bg-primary px-5 text-primary-foreground hover:bg-primary/90">
              Book a picking slot
            </LinkButton>
          </div>

          <Button type="button" variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen((value) => !value)} aria-label="Toggle menu">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
        {open && (
          <div className="border-t border-border/60 bg-card px-4 py-4 lg:hidden">
            <div className="mx-auto grid max-w-7xl gap-2">
              {[...NAV_ITEMS, { path: "/book", label: "Book a picking slot" }].map((item) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigateTo(item.path);
                  }}
                  className={cn(
                    "rounded-2xl px-4 py-3 text-left text-sm font-semibold",
                    route === item.path ? "bg-primary text-primary-foreground" : "bg-background text-foreground"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      <main>{children}</main>
      <Footer />
    </div>
  );
}

function StatusRibbon() {
  return (
    <div className="relative mx-auto max-w-max rotate-[-1deg] rounded-xl border-2 border-primary bg-accent px-5 py-3 text-center paper-shadow">
      <p className="text-xs font-black uppercase tracking-[0.25em] text-primary">Gate sign</p>
      <p className="font-display text-xl font-semibold text-foreground">Early summer picking opens Friday</p>
    </div>
  );
}

function BerryIllustration() {
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-[2rem] border border-border/70 bg-secondary paper-shadow">
      <div className="absolute inset-x-0 bottom-0 h-2/3 bg-[linear-gradient(160deg,hsl(var(--secondary)),hsl(91_44%_78%))]" />
      <div className="absolute left-1/2 top-6 h-24 w-40 -translate-x-1/2 rounded-full bg-accent/80 blur-sm" />
      {Array.from({ length: 7 }).map((_, index) => (
        <div
          key={index}
          className="absolute bottom-[-18%] h-[92%] w-8 origin-bottom rounded-full bg-[rgba(63,122,58,0.22)]"
          style={{ left: `${8 + index * 14}%`, transform: `rotate(${index % 2 ? -18 : 18}deg)` }}
        />
      ))}
      <div className="absolute bottom-8 left-8 right-8 rounded-[1.6rem] border border-primary/25 bg-card/92 p-5 shadow-xl backdrop-blur-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">Today’s field board</p>
            <p className="font-display text-2xl font-semibold">North meadow rows</p>
          </div>
          <Badge className="rounded-full bg-secondary text-secondary-foreground hover:bg-secondary">plenty available</Badge>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-sm font-bold">
          {['9:00', '10:30', '12:00'].map((slot, index) => (
            <div key={slot} className={cn("rounded-2xl px-2 py-3", index === 1 ? "bg-primary text-primary-foreground" : "bg-background")}>{slot}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ eyebrow, title, copy }) {
  return (
    <div className="max-w-3xl">
      <p className="mb-3 text-xs font-black uppercase tracking-[0.26em] text-primary">{eyebrow}</p>
      <h2 className="font-display text-4xl font-semibold leading-tight text-foreground sm:text-5xl">{title}</h2>
      {copy && <p className="mt-4 text-lg leading-8 text-muted-foreground">{copy}</p>}
    </div>
  );
}

function NewsletterSignup() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  async function submit(event) {
    event.preventDefault();
    setMessage("");
    if (!isEmail(email)) {
      setStatus("validation");
      setMessage("The email must look like an email address.");
      return;
    }
    setStatus("loading");
    try {
      await createNewsletterSignup(email);
      setStatus("success");
      setMessage("You’re on the Berry Brook Farm seasonal updates list. Watch for ripe-row notices and picking tips soon.");
      setEmail("");
    } catch {
      setStatus("error");
      setMessage("Newsletter signup failed, please try again.");
    }
  }

  return (
    <form onSubmit={submit} className="rounded-[1.5rem] bg-primary p-5 text-primary-foreground paper-shadow sm:col-span-2" noValidate>
      <Mail className="mb-4 h-5 w-5" />
      <p className="font-display text-2xl font-semibold">Join the seasonal updates list.</p>
      <p className="mt-2 text-sm leading-6 text-primary-foreground/85">We’ll send opening-day notes, ripe-row alerts and family visit reminders — no account required.</p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Label htmlFor="newsletter-email" className="sr-only">Email address</Label>
        <Input
          id="newsletter-email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (status === "validation" || status === "error") setMessage("");
          }}
          aria-invalid={status === "validation"}
          className="border-primary-foreground/40 bg-primary-foreground text-foreground placeholder:text-muted-foreground"
        />
        <Button type="submit" variant="secondary" className="rounded-full bg-accent text-accent-foreground hover:bg-accent/90" disabled={status === "loading"}>
          {status === "loading" ? "Joining…" : "Get farm updates"}
        </Button>
      </div>
      {message && (
        <p className={cn("mt-4 rounded-2xl p-3 text-sm font-bold", status === "success" ? "bg-secondary text-secondary-foreground" : "bg-primary-foreground text-primary")} role="status">
          {message}
        </p>
      )}
    </form>
  );
}

function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div className="absolute right-0 top-16 h-48 w-48 translate-x-1/3 rounded-full bg-accent/35 blur-3xl" aria-hidden="true" />
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-10 sm:px-6 md:grid-cols-[1.02fr_0.98fr] md:py-16 lg:px-8 lg:py-20">
          <div className="flex flex-col justify-center">
            <div className="mb-8 self-start"><StatusRibbon /></div>
            <p className="mb-4 text-sm font-black uppercase tracking-[0.28em] text-muted-foreground">From field sign to picking basket</p>
            <h1 className="font-display text-5xl font-semibold leading-[0.95] text-foreground sm:text-6xl lg:text-7xl">
              Strawberry season is here
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
              Berry Brook Farm welcomes pickers with timed rows, practical arrival notes and a warm handbill-style booking path. Choose a 90-minute picking window, bring your basket, and pay for strawberries by weight when you arrive.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <LinkButton to="/book" variant="default" size="lg" className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90">
                Book a picking slot <ChevronRight className="ml-2 h-4 w-4" />
              </LinkButton>
              <LinkButton to="/visit" variant="outline" size="lg" className="rounded-full border-border bg-card/70">
                Plan your visit
              </LinkButton>
            </div>
          </div>
          <div className="relative">
            <BerryIllustration />
            <div className="mt-4 rounded-[1.75rem] border border-primary/30 bg-card p-5 paper-shadow md:absolute md:-bottom-8 md:-left-8 md:mt-0 md:max-w-xs">
              <p className="text-xs font-black uppercase tracking-[0.2em] text-primary">Your picking basket</p>
              <p className="mt-2 font-display text-2xl font-semibold">Reservation summary will live here.</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Sticky, stitched and practical once booking steps arrive.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <SectionHeader eyebrow="How it works" title="A guided route from arrival window to weighed berries." copy="The foundation includes the route structure and shared components for the full customer journey." />
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {highlights.map((item, index) => {
            const Icon = item.icon;
            return (
              <Card key={item.title} className={cn("overflow-hidden border-border/70 bg-card paper-shadow", index === 1 && "md:translate-y-6")}>
                <CardContent className="p-6">
                  <div className="mb-6 flex items-center justify-between">
                    <div className="grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-secondary-foreground"><Icon className="h-6 w-6" /></div>
                    <span className="font-display text-4xl text-primary/25">0{index + 1}</span>
                  </div>
                  <h3 className="font-display text-2xl font-semibold">{item.title}</h3>
                  <p className="mt-3 leading-7 text-muted-foreground">{item.copy}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="bg-secondary/70 py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8">
          <SectionHeader eyebrow="Farm highlights" title="Cream paper notes for a real countryside visit." />
          <div className="grid gap-4 sm:grid-cols-2">
            {visitorNotes.map((note) => (
              <div key={note} className="rounded-[1.5rem] bg-background p-5 paper-shadow">
                <Leaf className="mb-4 h-5 w-5 text-primary" />
                <p className="font-semibold leading-7">{note}</p>
              </div>
            ))}
            <NewsletterSignup />
          </div>
        </div>
      </section>
    </>
  );
}

function PlaceholderPage({ eyebrow, title, copy, icon: Icon }) {
  return (
    <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-20">
      <div className="grid gap-10 lg:grid-cols-[0.78fr_1.22fr] lg:items-start">
        <aside className="rounded-[2rem] border border-primary/25 bg-card p-6 paper-shadow">
          <div className="mb-6 flex items-center gap-3">
            <FarmMark small />
            <div>
              <p className="text-xs font-black uppercase tracking-[0.22em] text-primary">Berry Brook Farm</p>
              <p className="text-sm font-semibold text-muted-foreground">Foundation route</p>
            </div>
          </div>
          <div className="rounded-[1.5rem] bg-secondary p-5 text-secondary-foreground">
            <Icon className="mb-4 h-7 w-7" />
            <p className="font-display text-2xl font-semibold leading-tight">Shared orchard-row layout area.</p>
            <p className="mt-3 text-sm leading-6">Navigation, typography, colour tokens and page framing are ready for the detailed journey.</p>
          </div>
        </aside>
        <div className="relative overflow-hidden rounded-[2.5rem] border border-border/70 bg-card p-7 paper-shadow sm:p-10 lg:p-12">
          <div className="absolute right-6 top-6 hidden rotate-12 text-7xl text-primary/10 sm:block" aria-hidden="true">✦</div>
          <p className="mb-4 text-xs font-black uppercase tracking-[0.28em] text-primary">{eyebrow}</p>
          <h1 className="max-w-4xl font-display text-5xl font-semibold leading-[0.98] sm:text-6xl">{title}</h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-muted-foreground">{copy}</p>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {['Cream paper surface', 'Leaf-green guide state', 'Strawberry-red emphasis'].map((label, index) => (
              <div key={label} className={cn("rounded-[1.25rem] p-4 text-sm font-bold", index === 0 && "bg-background", index === 1 && "bg-secondary text-secondary-foreground", index === 2 && "bg-primary text-primary-foreground")}>{label}</div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function AvailabilityBadge({ slot }) {
  const tone = slot.remaining === 0 ? "bg-primary text-primary-foreground" : slot.remaining <= 5 ? "bg-accent text-foreground" : "bg-secondary text-secondary-foreground";
  return <Badge className={cn("rounded-full", tone)}>{slot.availabilityLabel} · {slot.remaining} spaces</Badge>;
}

function CountControl({ label, value, onChange }) {
  return (
    <div className="rounded-[1.25rem] border border-border/70 bg-background p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="font-display text-xl font-semibold">{label}</span>
        <span className="text-2xl font-black text-primary">{value}</span>
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="icon" className="rounded-full" onClick={() => onChange(Math.max(0, value - 1))} aria-label={`Remove ${label}`}><Minus className="h-4 w-4" /></Button>
        <Button type="button" variant="outline" size="icon" className="rounded-full" onClick={() => onChange(value + 1)} aria-label={`Add ${label}`}><Plus className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function BasketSummary({ selectedDay, selectedSlot, adults, children }) {
  const total = adults + children;
  return (
    <aside className="sticky top-24 rounded-[2rem] border-2 border-dashed border-primary bg-card p-6 paper-shadow">
      <p className="text-xs font-black uppercase tracking-[0.22em] text-primary">Your picking basket</p>
      <h2 className="mt-2 font-display text-3xl font-semibold">Reservation summary</h2>
      <div className="mt-5 space-y-3 text-sm leading-6">
        <p><strong>Date:</strong> {selectedDay ? selectedDay.longLabel : "Choose a field date"}</p>
        <p><strong>Time:</strong> {selectedSlot ? `${selectedSlot.label} · 90 minutes` : "Choose a timed slot"}</p>
        <p><strong>Party:</strong> {total ? `${total} picker${total === 1 ? "" : "s"} (${adults} adult, ${children} child)` : "Add visitors"}</p>
        <p className="rounded-2xl bg-secondary p-3 font-semibold text-secondary-foreground">No online deposit today. Entry is settled on arrival; strawberries paid by weight on arrival.</p>
      </div>
    </aside>
  );
}

function BookingConfirmation({ booking }) {
  const [calendarNote, setCalendarNote] = useState(false);
  return (
    <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="rounded-[2.5rem] border border-primary/30 bg-card p-7 paper-shadow sm:p-10">
        <Badge className="rounded-full bg-secondary text-secondary-foreground">booking confirmed</Badge>
        <h1 className="mt-4 font-display text-5xl font-semibold">Your strawberry slot is reserved.</h1>
        <p className="mt-4 text-lg leading-8 text-muted-foreground">Reference <strong className="text-foreground">{booking.reference}</strong> has been saved. Use it with {booking.customerEmail} to look up this reservation after a reload.</p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl bg-background p-5"><p className="text-xs font-black uppercase tracking-[0.2em] text-primary">Arrive</p><p className="mt-2 font-semibold">10 minutes before {booking.slotLabel}</p></div>
          <div className="rounded-2xl bg-background p-5"><p className="text-xs font-black uppercase tracking-[0.2em] text-primary">Check in</p><p className="mt-2 font-semibold">Give reference {booking.reference} at the farm gate.</p></div>
          <div className="rounded-2xl bg-background p-5"><p className="text-xs font-black uppercase tracking-[0.2em] text-primary">Pay</p><p className="mt-2 font-semibold">Strawberries are paid by weight on arrival.</p></div>
        </div>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button type="button" className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setCalendarNote(true)}><CalendarDays className="mr-2 h-4 w-4" /> Add-to-calendar reminder</Button>
          <LinkButton to="/booking/manage" variant="outline" className="rounded-full bg-background">Manage this booking</LinkButton>
        </div>
        {calendarNote && <p className="mt-4 rounded-2xl bg-secondary p-4 font-semibold text-secondary-foreground">Calendar reminder noted for this demo — no external calendar file or provider is opened.</p>}
      </div>
    </section>
  );
}

function BookPage() {
  const [availability, setAvailability] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [form, setForm] = useState({ customerName: "", customerEmail: "", customerPhone: "", termsAccepted: false });
  const [validation, setValidation] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [booking, setBooking] = useState(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      setLoadError("");
      try {
        await ensureBookingSession();
        const data = await getSlotAvailability();
        if (alive) setAvailability(data);
      } catch (error) {
        if (alive) setLoadError(error.message || "Slot availability could not be loaded.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, []);

  const selectedDay = availability.find((day) => day.date === selectedDate);
  const selectedSlot = selectedDay?.slots.find((slot) => slot.id === selectedSlotId);
  const allFull = selectedDay?.slots.every((slot) => slot.remaining === 0);

  async function submitBooking(event) {
    event.preventDefault();
    setValidation("");
    setSubmitError("");
    if (!selectedDate) return setValidation("Choose an available picking date before continuing.");
    if (!selectedSlotId) return setValidation("A timed 90-minute slot must be selected before continuing.");
    if (adults + children <= 0 || !form.customerName.trim() || !isEmail(form.customerEmail) || !form.customerPhone.trim() || form.termsAccepted !== true) {
      return setValidation("Name, valid email, phone and farm terms acceptance are required.");
    }
    setSubmitting(true);
    try {
      await ensureBookingSession();
      const created = await createBooking({ date: selectedDate, slotId: selectedSlotId, adults, children, ...form });
      setBooking(created);
    } catch (error) {
      setSubmitError(error.message?.toLowerCase().includes("slot") ? "That slot is no longer available." : "Saving failed, try again.");
      try { setAvailability(await getSlotAvailability()); } catch {}
    } finally {
      setSubmitting(false);
    }
  }

  if (booking) return <BookingConfirmation booking={booking} />;

  return (
    <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
      <div className="mb-8 max-w-3xl">
        <p className="text-xs font-black uppercase tracking-[0.28em] text-primary">Book a picking slot</p>
        <h1 className="mt-3 font-display text-5xl font-semibold leading-none sm:text-6xl">Choose your orchard row arrival.</h1>
        <p className="mt-5 text-lg leading-8 text-muted-foreground">Reserve a 90-minute strawberry picking window. No card payment is taken online.</p>
      </div>
      <div className="grid gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
        <form onSubmit={submitBooking} className="space-y-6" noValidate>
          <Card className="border-border/70 bg-card paper-shadow"><CardContent className="p-6">
            <p className="mb-4 font-display text-2xl font-semibold">1. Pick a date</p>
            {loading && <StateNote className="mb-4">Availability is loading while seeded dates and existing bookings are evaluated…</StateNote>}
            {!loading && !loadError && availability.length === 0 && <StateNote tone="warn" className="mb-4">No picking dates are currently available. <button type="button" className="underline" onClick={() => navigateTo("/visit")}>Read visitor information</button> for farm updates.</StateNote>}
            {loadError && <StateNote tone="error" className="mb-4">Availability could not be loaded, please try again.</StateNote>}
            <div className="flex gap-3 overflow-x-auto pb-2">
              {(availability.length ? availability : PICKING_DATES).map((day) => (
                <button key={day.date} type="button" onClick={() => { setSelectedDate(day.date); setSelectedSlotId(""); setValidation(""); }} className={cn("min-w-44 rounded-[1.25rem] border p-4 text-left transition", selectedDate === day.date ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-secondary") }>
                  <span className="block font-display text-xl font-semibold">{day.label}</span><span className="mt-2 block text-sm opacity-80">{day.note}</span>
                </button>
              ))}
            </div>
          </CardContent></Card>

          <Card className="border-border/70 bg-card paper-shadow"><CardContent className="p-6">
            <div className="mb-4 flex items-center justify-between gap-3"><p className="font-display text-2xl font-semibold">2. Select a timed 90-minute slot</p>{loading && <Badge className="rounded-full bg-accent text-foreground">calculating</Badge>}</div>
            {loadError && <StateNote tone="error">Availability could not be loaded, please try again.</StateNote>}
            {!selectedDate && <StateNote>Choose a date to see the planted-row slot selector.</StateNote>}
            {selectedDate && loading && <StateNote>Slot availability indicators are calculating…</StateNote>}
            {selectedDay && allFull && <StateNote tone="error" className="mb-4">All slots for this date are full and cannot be selected.</StateNote>}
            {selectedDay && !loading && <div className="grid gap-3 sm:grid-cols-2">
              {selectedDay.slots.map((slot) => {
                const disabled = slot.remaining === 0;
                return <button key={slot.id} type="button" disabled={disabled} onClick={() => { setSelectedSlotId(slot.id); setValidation(""); }} className={cn("rounded-[1.25rem] border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-55", selectedSlotId === slot.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-secondary") }>
                  <span className="block font-display text-xl font-semibold">{slot.label}</span><span className="mt-3 inline-flex"><AvailabilityBadge slot={slot} /></span>{selectedSlotId === slot.id && <span className="mt-3 block text-sm font-bold">Selected · {slot.remaining} spaces remaining</span>}
                </button>;
              })}
            </div>}
            {validation && <StateNote tone="warn" className="mt-4">{validation}</StateNote>}
            {submitError && <StateNote tone="error" className="mt-4">{submitError}</StateNote>}
          </CardContent></Card>

          <Card className={cn("border-border/70 bg-card paper-shadow", !selectedSlot && "opacity-65")}><CardContent className="p-6">
            <p className="mb-4 font-display text-2xl font-semibold">3. Visitors and contact details</p>
            {!selectedDate || !selectedSlot ? <StateNote className="mb-4">Your booking summary is waiting — choose a date, time and party size before saving your reservation.</StateNote> : null}
            <div className="grid gap-4 sm:grid-cols-2"><CountControl label="Adults" value={adults} onChange={setAdults} /><CountControl label="Children" value={children} onChange={setChildren} /></div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="name">Name</Label><Input id="name" required value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} /></div>
              <div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" required value={form.customerEmail} onChange={(e) => setForm({ ...form, customerEmail: e.target.value })} /></div>
              <div className="space-y-2 sm:col-span-2"><Label htmlFor="phone">Phone</Label><Input id="phone" required value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} /></div>
            </div>
            <label className="mt-5 flex items-start gap-3 rounded-2xl bg-background p-4 text-sm font-semibold leading-6"><Checkbox checked={form.termsAccepted} onCheckedChange={(checked) => setForm({ ...form, termsAccepted: checked === true })} /> I accept the farm terms: timed arrival, uneven ground, children supervised, and berries paid by weight on arrival.</label>
            {submitting && <StateNote tone="success" className="mt-5">Saving reservation…</StateNote>}
            <Button type="submit" size="lg" className="mt-6 rounded-full bg-primary text-primary-foreground hover:bg-primary/90" disabled={submitting}>{submitting ? "Reserving…" : "Reserve picking slot"}</Button>
          </CardContent></Card>
        </form>
        <BasketSummary selectedDay={selectedDay} selectedSlot={selectedSlot} adults={adults} children={children} />
      </div>
    </section>
  );
}

function BookingDetails({ booking, onCancel, cancelling }) {
  const cancelled = booking.status === BOOKING_STATUS.CANCELLED;
  return (
    <div className="mt-8 rounded-[2rem] border border-primary/30 bg-card p-6 paper-shadow">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3"><TicketCheck className="h-6 w-6 text-primary" /><h2 className="font-display text-3xl font-semibold">Reservation {booking.reference}</h2></div>
        <Badge className={cn("w-fit rounded-full", cancelled ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground")}>{booking.status}</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <p className="rounded-2xl bg-background p-4"><strong>Date</strong><br />{DATE_LABELS[booking.date] || booking.date}</p>
        <p className="rounded-2xl bg-background p-4"><strong>Time</strong><br />{booking.slotLabel}</p>
        <p className="rounded-2xl bg-background p-4"><strong>Party</strong><br />{booking.totalGuests} pickers ({booking.adults} adult, {booking.children} child)</p>
        <p className="rounded-2xl bg-background p-4"><strong>Contact</strong><br />{booking.customerName}<br />{booking.customerEmail}<br />{booking.customerPhone}</p>
        <p className="rounded-2xl bg-secondary p-4 text-secondary-foreground"><strong>Arrival</strong><br />Check in at the red farm-gate sign; strawberries paid by weight on arrival.</p>
      </div>
      {cancelled ? (
        <StateNote tone="warn" className="mt-5">Cancelled status is visible for this reservation. There is no active cancel button.</StateNote>
      ) : (
        <Button type="button" variant="outline" className="mt-6 rounded-full border-primary bg-background text-primary hover:bg-primary/10" disabled={cancelling} onClick={onCancel}>
          {cancelling ? "Cancelling…" : "Cancel reservation"}
        </Button>
      )}
    </div>
  );
}

function ManageBookingPage() {
  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  const [booking, setBooking] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelMessage, setCancelMessage] = useState("");

  async function lookup(event) {
    event.preventDefault();
    if (!reference.trim() || !isEmail(email)) {
      setMessage("Booking reference and valid email are required.");
      setBooking(null);
      return;
    }
    setLoading(true); setMessage(""); setBooking(null);
    try {
      await ensureBookingSession();
      const found = await readBookingByReferenceEmail(reference, email);
      if (found) setBooking(found);
      else setMessage("We could not find that reservation.");
    } catch (error) {
      setMessage("We could not find that reservation.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel() {
    if (!booking || !window.confirm("Cancel this Berry Brook Farm reservation? The spaces will return to the field calendar.")) return;
    setCancelling(true);
    setCancelMessage("");
    try {
      await ensureBookingSession();
      const cancelled = await cancelBooking(booking);
      setBooking(cancelled);
      setCancelMessage("Reservation cancelled. The party spaces have returned to slot availability.");
    } catch {
      setCancelMessage("Cancellation failed, please try again.");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8 lg:py-20">
      <p className="text-xs font-black uppercase tracking-[0.28em] text-primary">Manage booking</p>
      <h1 className="mt-3 font-display text-5xl font-semibold leading-none sm:text-6xl">Look up your picking basket.</h1>
      {!booking && !message && !loading && <StateNote className="mt-6">Enter your booking reference and email to view reservation details or cancel an active visit.</StateNote>}
      <form onSubmit={lookup} className="mt-8 rounded-[2rem] border border-border/70 bg-card p-6 paper-shadow">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="lookup-reference">Booking reference</Label><Input id="lookup-reference" required placeholder="BBF-ABC234" value={reference} onChange={(e) => setReference(e.target.value.toUpperCase())} /></div>
          <div className="space-y-2"><Label htmlFor="lookup-email">Email</Label><Input id="lookup-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        </div>
        <Button type="submit" className="mt-6 rounded-full bg-primary text-primary-foreground hover:bg-primary/90" disabled={loading}>{loading ? "Looking up reservation…" : "Find reservation"}</Button>
        {loading && <StateNote className="mt-4">Looking up reservation…</StateNote>}
        {message && <StateNote tone={message.includes("required") ? "warn" : "error"} className="mt-4">{message}</StateNote>}
      </form>
      {booking && <BookingDetails booking={booking} onCancel={handleCancel} cancelling={cancelling} />}
      {cancelMessage && <StateNote tone={cancelMessage.includes("failed") ? "error" : "success"} className="mt-4">{cancelMessage}</StateNote>}
    </section>
  );
}

function VisitPage() {
  const notes = [
    { icon: Clock, title: "Opening hours", copy: "Picking gates open 9:00am–3:30pm on bookable strawberry days. Please arrive within your timed window." },
    { icon: Sun, title: "What to bring", copy: "Comfortable shoes, sun hats, water, a reusable punnet or basket, and a light layer for breezy meadow edges." },
    { icon: Leaf, title: "Field etiquette", copy: "Stay in labelled rows, supervise children, pick only ripe red berries, and follow the hand-painted signs back to weigh-out." },
    { icon: Umbrella, title: "Weather guidance", copy: "We pick in light summer showers, pause during thunder, and recommend checking local forecasts before leaving home." },
    { icon: Users, title: "Accessibility", copy: "The farm has uneven grass paths; call ahead for closest parking advice and gentler rows near the gate." },
  ];

  return (
    <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-20">
      <SectionHeader eyebrow="Plan your visit" title="Practical field notes for a smooth picking day." copy="Everything here is static visitor advice — no live weather feed or external map provider is used." />
      <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {notes.map((item, index) => {
          const Icon = item.icon;
          return (
            <Card key={item.title} className={cn("border-border/70 bg-card paper-shadow", index === 1 && "lg:translate-y-6")}>
              <CardContent className="p-6">
                <div className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-secondary-foreground"><Icon className="h-6 w-6" /></div>
                <h2 className="font-display text-2xl font-semibold">{item.title}</h2>
                <p className="mt-3 leading-7 text-muted-foreground">{item.copy}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <div className="mt-12 grid gap-8 lg:grid-cols-[1fr_1.05fr] lg:items-stretch">
        <div className="rounded-[2rem] border border-primary/25 bg-card p-7 paper-shadow">
          <p className="text-xs font-black uppercase tracking-[0.26em] text-primary">Directions</p>
          <h2 className="mt-3 font-display text-4xl font-semibold">Find the red farm-gate sign.</h2>
          <p className="mt-4 leading-8 text-muted-foreground">Berry Brook Farm, Berry Brook Lane, Meadow County. From Mill Road, follow the brown strawberry signs for 1.2 miles, turn left at the oak shelter, then park in the mown meadow on the right.</p>
          <p className="mt-4 rounded-2xl bg-secondary p-4 font-semibold text-secondary-foreground">External maps are deferred: use these written directions and the map-style guide beside them.</p>
        </div>
        <div className="relative min-h-[360px] overflow-hidden rounded-[2rem] border border-border/70 bg-secondary paper-shadow" aria-label="Map-style visual placeholder showing Berry Brook Farm location details">
          <div className="absolute inset-0 opacity-60" style={{ backgroundImage: "linear-gradient(90deg, rgba(63,122,58,.18) 1px, transparent 1px), linear-gradient(rgba(63,122,58,.18) 1px, transparent 1px)", backgroundSize: "52px 52px" }} />
          <div className="absolute left-8 top-10 rounded-full bg-background px-4 py-2 text-sm font-black text-primary paper-shadow">Mill Road</div>
          <div className="absolute bottom-12 right-10 rounded-full bg-primary px-5 py-3 font-display text-xl font-semibold text-primary-foreground paper-shadow"><MapPin className="mr-2 inline h-5 w-5" /> Berry Brook Farm</div>
          <div className="absolute left-12 top-28 h-40 w-[70%] rotate-[-8deg] rounded-full border-t-4 border-dashed border-primary/70" />
          <div className="absolute bottom-20 left-10 rounded-2xl bg-card p-4 text-sm font-semibold leading-6 paper-shadow">Parking meadow · farm gate · weigh-out table</div>
        </div>
      </div>
    </section>
  );
}

function OurFarmPage() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-20">
      <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
        <div>
          <SectionHeader eyebrow="Our farm" title="Berry Brook grows strawberries for slow summer mornings." copy="Our family-run fields sit between hedgerows, meadow grass and a small brook that keeps the soil cool through warm spells." />
          <div className="mt-8 flex flex-col gap-3 sm:flex-row"><LinkButton to="/book" className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90" variant="default">Book a picking slot</LinkButton><LinkButton to="/visit" className="rounded-full bg-card" variant="outline">Read visit notes</LinkButton></div>
        </div>
        <div className="relative overflow-hidden rounded-[2.5rem] border border-border/70 bg-card p-5 paper-shadow">
          <div className="aspect-[4/3] rounded-[2rem] bg-secondary p-6">
            <div className="grid h-full grid-cols-3 gap-3">
              <div className="rounded-full bg-primary/20" />
              <div className="translate-y-8 rounded-full bg-accent/70" />
              <div className="rounded-full bg-secondary-foreground/20" />
            </div>
          </div>
          <p className="mt-4 text-sm font-semibold text-muted-foreground">Photography-style farm panel placeholder: rows, hands, berries and meadow light — no upload controls.</p>
        </div>
      </div>
      <div className="mt-14 grid gap-6 lg:grid-cols-3">
        {[
          { icon: Wheat, title: "Soil-first growing", copy: "Compost, straw mulch and resting rows help keep the strawberry beds resilient without turning the visit into a lecture." },
          { icon: Leaf, title: "Hedgerow habitat", copy: "Leafy margins and flowering strips support pollinators around the picking fields." },
          { icon: HeartHandshake, title: "Farm-gate team", copy: "A small seasonal crew guides arrivals, explains row labels and weighs berries with a friendly pace for families." },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <Card key={item.title} className="border-border/70 bg-card paper-shadow">
              <CardContent className="p-6">
                <div className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-secondary-foreground"><Icon className="h-6 w-6" /></div>
                <h2 className="font-display text-2xl font-semibold">{item.title}</h2>
                <p className="mt-3 leading-7 text-muted-foreground">{item.copy}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border/70 bg-card/70">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.2fr_0.8fr_0.8fr] lg:px-8">
        <div>
          <div className="mb-4 flex items-center gap-3"><FarmMark small /><span className="font-display text-2xl font-semibold">Berry Brook Farm</span></div>
          <p className="max-w-md leading-7 text-muted-foreground">A sunny customer-facing foundation for seasonal strawberry picking reservations, practical visit planning and booking management.</p>
        </div>
        <div>
          <h3 className="mb-3 font-display text-xl font-semibold">Visit basics</h3>
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><MapPin className="h-4 w-4" /> Berry Brook Lane, Meadow County</p>
          <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><Car className="h-4 w-4" /> Written directions only at this stage</p>
        </div>
        <div>
          <h3 className="mb-3 font-display text-xl font-semibold">Season status</h3>
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Sun className="h-4 w-4" /> Early summer picking opens Friday</p>
        </div>
      </div>
    </footer>
  );
}

export default function App() {
  const route = useRoute();
  let page = <HomePage />;
  if (route === "/book") page = <BookPage />;
  if (route === "/booking/manage") page = <ManageBookingPage />;
  if (route === "/visit") page = <VisitPage />;
  if (route === "/our-farm") page = <OurFarmPage />;

  return <AppShell route={route}>{page}</AppShell>;
}
