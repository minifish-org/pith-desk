import {createImageGroupPart,createImagePart,type LayoutPart,type ImagePart,type ImageData} from 'pith-ui';

export interface ImageTarget {readonly conversationId: string;readonly messageId: string;readonly index: number}
export interface ImageReference {index: number;mimeType?: string}
export interface GalleryCallbacks {onLoadImage?(target: ImageTarget): Blob|null|undefined|Promise<Blob|null|undefined>;onImage?(image: ImageData): void}
export interface ImageGalleryComposition {readonly part: LayoutPart;update(images: readonly ImageReference[]): void}
export interface ConversationImageScope {gallery(messageId: string,images: readonly ImageReference[]): ImageGalleryComposition;reset(): void;destroy(): void}

/** Image resolution/cache ownership is caller coordination. Small native image
 * and gallery parts know only their projected source, state and activation. */
export function createConversationImageScope(conversation: () => string,callbacks: GalleryCallbacks): ConversationImageScope {
  let alive = true,generation = 0,requested = new WeakSet<ImagePart>();
  const cache = new Map<string,Promise<string|null>>(),urls = new Set<string>();
  const reset = () => {generation++;requested = new WeakSet();cache.clear();for (const url of urls) URL.revokeObjectURL(url);urls.clear();};
  const load = (image: ImagePart,messageId: string,index: number) => {
    if (!alive || requested.has(image)) return;requested.add(image);
    const current = generation,target = Object.freeze({conversationId: conversation(),messageId,index}),key = JSON.stringify([target.conversationId,messageId,index]);
    let pending = cache.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => callbacks.onLoadImage?.(target)).then(blob => {
        if (!alive || current !== generation || !blob || !['image/png','image/jpeg','image/gif','image/webp'].includes(blob.type)) return null;
        const url = URL.createObjectURL(blob);urls.add(url);return url;
      }).catch(() => null);cache.set(key,pending);
    }
    void pending.then(src => {
      if (!alive || current !== generation || target.conversationId !== conversation()) return;
      if (!src) {requested.delete(image);if (cache.get(key) === pending) cache.delete(key);}
      image.update(src ? {src,alt: `Image ${index+1}`,status: 'ready'} : {status: 'unavailable'});
    });
  };
  return {reset,destroy() {if (alive) {alive = false;reset();}},gallery(messageId,initial) {
    const images = new Map<string,ImagePart>(),part = createImageGroupPart({children: []});
    const update = (next: readonly ImageReference[]) => {
      if (!alive) return;
      const counts = new Map<number,number>(),rows = next.map(reference => {const count = counts.get(reference.index) ?? 0;counts.set(reference.index,count+1);return {...reference,key: JSON.stringify([reference.index,count])};});
      const keep = new Set(rows.map(row => row.key));for (const [key,image] of images) if (!keep.has(key)) {image.destroy();images.delete(key);}
      for (const row of rows) {let image = images.get(row.key);if (!image) {image = createImagePart({purpose: 'content',alt: `Image ${row.index+1}`,onActivate(data) {if (alive) callbacks.onImage?.(data);}});images.set(row.key,image);}load(image,messageId,row.index);}
      part.replace(rows.map(row => images.get(row.key)!));
    };
    update(initial);return {part,update};
  }};
}
