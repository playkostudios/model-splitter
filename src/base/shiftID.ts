export function shiftID(origID: number, deletedIDs: Iterable<number>): number {
    let newID = origID;
    for (const deletedID of deletedIDs) {
        if (origID > deletedID) {
            newID--;
        }
    }

    return newID;
}