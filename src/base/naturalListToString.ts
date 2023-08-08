export function naturalListToString(list: Array<string>): string {
    const len = list.length;
    if (len < 2) {
        return list[0] ?? '';
    }

    const parts = [list[0]];
    const last = len - 1;
    for (let i = 1; i < len; i++) {
        if (i === last) {
            parts.push(' and ');
        } else {
            parts.push(', ');
        }

        parts.push(list[i]);
    }

    return parts.join('');
}