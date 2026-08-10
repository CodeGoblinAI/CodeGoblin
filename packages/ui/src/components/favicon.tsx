import { Link, Meta } from "@solidjs/meta"

export const Favicon = () => {
  return (
    <>
      <Link rel="icon" type="image/png" href="/codegoblin-logo.png" />
      <Link rel="shortcut icon" href="/codegoblin-logo.png" />
      <Link rel="apple-touch-icon" href="/codegoblin-logo.png" />
      <Link rel="manifest" href="/site.webmanifest" />
      <Meta name="apple-mobile-web-app-title" content="CodeGoblin" />
    </>
  )
}
