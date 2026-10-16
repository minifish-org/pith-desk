// Consume the four Host capabilities once; credentials stay in closures.
export function readAppBootstrap() {
  const consume = (name: string): string => {
    const meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
    const value = meta?.content ?? '';
    meta?.remove();
    return value;
  };
  const token = consume('desk-token');
  return {
    token: token === '__DESK_TOKEN__' ? '' : token,
    nativeClipboard: consume('desk-native-clipboard') === 'true',
    nativeFileDrop: consume('desk-native-file-drop') === 'true',
    nativeMenus: consume('desk-native-menus') === 'true',
    appearance: document.documentElement.dataset.appearance,
  };
}
