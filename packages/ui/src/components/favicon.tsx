import { Link, Meta } from "@solidjs/meta"

export const Favicon = () => {
  return (
    <>
      <Link rel="icon" type="image/svg+xml" href="/favicon-v3.svg" />
      <Link rel="shortcut icon" href="/favicon-v3.svg" />
      <Link rel="apple-touch-icon" href="/favicon-v3.svg" />
      <Link rel="manifest" href="/site.webmanifest" />
      <Meta name="apple-mobile-web-app-title" content="CodeGoblin" />
    </>
  )
}
