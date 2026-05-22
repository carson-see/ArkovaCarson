export interface ToastLocation {
  pathname: string;
  search: string;
}

export function shouldDismissToastsForLocationChange(previous: ToastLocation, current: ToastLocation): boolean {
  return previous.pathname !== current.pathname;
}
