# JavaScript Layout

File Pipe uses classic deferred browser scripts rather than a build step. Keep files in this structure so page load order stays explicit in the templates.

- `pages/<page>/index.js`: Alpine component state and page actions.
- `pages/<page>/helpers.js`: page-local constants, protocol helpers, and media/WebRTC utilities used by that page.
- `player/`: reusable player modules shared by host, watch, and Bigscreen pages.
- `../bigscreen-sw.js`: service worker kept at the static root so it can be registered with `/` scope.

When adding a new browser feature, put reusable player/runtime code under `player/`, page-specific behavior under the matching `pages/<page>/` folder, and update the template script order so helpers load before the page entrypoint.
