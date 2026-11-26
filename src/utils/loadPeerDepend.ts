export async function loadPeer<T>(pkg: string, feature: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    throw new Error(
      `Optional dependency "${pkg}" is required for ${feature}. Install it with: npm install ${pkg}`,
      { cause: err },
    );
  }
}
