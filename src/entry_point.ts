
var entry_point: string | null = null;

export function get_entry_point(): string | null {
    return entry_point;
}

export function set_entry_point(ep: string) {
    entry_point = ep;
}
