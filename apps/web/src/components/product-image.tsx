/**
 * Renders a product image from an arbitrary, seller-supplied URL.
 *
 * Deliberately a plain <img>, not next/image's <Image>: next/image requires
 * every remote hostname to be explicitly whitelisted in next.config.ts's
 * images.remotePatterns (it's an image PROXY — allowing arbitrary hosts
 * there is a real SSRF/cost-abuse surface, not a config detail to wave
 * away). Sellers can enter ANY image URL when creating a listing (no
 * upload pipeline exists yet — see listing-service.ts's own comment), so a
 * whitelist-based component cannot be the one used for seller content.
 *
 * Confirmed the actual failure mode before writing this, not assumed: a
 * non-whitelisted host doesn't degrade gracefully — it 500s the ENTIRE
 * page (`Invalid src prop ... hostname "..." is not configured under
 * images`), reproduced against a real product created with a non-picsum
 * image URL and a real running server.
 *
 * One component, not five inline fixes, so the day real image upload
 * (with its own CDN/allowlist) exists, there's one place to point at it.
 */

import type { CSSProperties } from "react";

interface Props {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
  priority?: boolean;
}

export function ProductImage({ src, alt, width, height, className, style, priority }: Props) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see module comment
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      style={style}
      loading={priority ? "eager" : "lazy"}
    />
  );
}
