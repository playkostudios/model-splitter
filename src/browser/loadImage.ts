export function loadImage(urlFilename: string, urlRoot: string | undefined, timeoutMS: number): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = document.createElement('img');
        const url = new URL(urlFilename, urlRoot);
        img.src = url.href;

        function settle(callback: CallableFunction) {
            if (timeout !== null) {
                clearTimeout(timeout);
                timeout = null;
                callback();
            }
        }

        const timeoutReject = () => reject(new Error('Timed out'));
        // XXX for some reason typescript uses the nodejs settimeout definition,
        //     so we cast
        let timeout: number | null = setTimeout(() => settle(timeoutReject), timeoutMS) as unknown as number;
        img.addEventListener('load', () => settle(() => resolve(img)));
        img.addEventListener('error', (ev) => {
            settle(() => reject(ev.error ?? new Error('Error occurred while loading image')));
        });
    });
}