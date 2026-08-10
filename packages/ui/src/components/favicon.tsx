import { Link, Meta } from "@solidjs/meta"

export const Favicon = () => {
  return (
    <>
      <Link rel="icon" type="image/svg+xml" href="/favicon-v4.svg" />
      <Link rel="shortcut icon" href="/favicon-v4.svg" />
      <Link rel="apple-touch-icon" href="/codegoblin-logo.png" />
      <Link rel="manifest" href="/site.webmanifest" />
      <Meta name="apple-mobile-web-app-title" content="CodeGoblin" />
    </>
  )
}
