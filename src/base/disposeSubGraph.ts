import { type Scene, type Node } from '@gltf-transform/core';

export function disposeSubGraph(target: Scene | Node): void {
    // XXX we're doing this dance because i want to avoid recursion, but at the
    //     same time the graph also needs to be traversed from child-to-parent.
    //     this looks pretty bad because i'm trying to be efficient, but it
    //     basically builds a stack which, when popped, traverses the input
    //     graph from child-to-parent
    const disposeStack: (Scene | Node)[] = [target];
    for (let i = 0; i < disposeStack.length; i++) {
        disposeStack.push(...disposeStack[i].listChildren());
    }

    let focus: Scene | Node | undefined;
    while ((focus = disposeStack.pop())) {
        focus.dispose();
    }
}