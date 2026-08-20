/** Read-only star display — rating is 1-5, possibly fractional (an average). */
export function StarRating({ rating, size = "1em" }: { rating: number; size?: string }) {
  const rounded = Math.round(rating * 2) / 2; // nearest half-star

  return (
    <span aria-label={`${rating.toFixed(1)} out of 5 stars`} style={{ fontSize: size, letterSpacing: "1px" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} style={{ color: n <= rounded ? "#d4a017" : "var(--border-strong)" }}>
          ★
        </span>
      ))}
    </span>
  );
}
