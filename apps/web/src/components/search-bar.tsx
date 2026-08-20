"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { autocompleteAction } from "@/server/actions/search-actions";
import type { AutocompleteSuggestion } from "@/server/search/search-service";

const DEBOUNCE_MS = 200;

export function SearchBar() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const query = value.trim();
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }

    debounceRef.current = setTimeout(() => {
      const thisRequestId = ++requestIdRef.current;
      autocompleteAction(query).then((results) => {
        // Ignore a stale response that lost the race against a newer keystroke.
        if (thisRequestId === requestIdRef.current) setSuggestions(results);
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value]);

  function submit(query: string) {
    setOpen(false);
    const trimmed = query.trim();
    if (trimmed) router.push(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <div className="search-bar">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
      >
        <input
          type="search"
          name="q"
          placeholder="Search products…"
          aria-label="Search products"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          autoComplete="off"
        />
      </form>
      {open && suggestions.length > 0 && (
        <ul className="search-bar__suggestions">
          {suggestions.map((s) => (
            <li key={s.slug}>
              <Link href={`/products/${s.slug}`} onMouseDown={() => setOpen(false)}>
                {s.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
