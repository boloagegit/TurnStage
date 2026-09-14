import { describe, expect, it } from 'vitest';
import { profileUrl, requestedProfileId } from '../web/src/profileUrl';

describe('Web profile deep link', () => {
  it('reads a profile ID without treating names or empty values as IDs', () => {
    expect(requestedProfileId('?profile=basic-sse-chat')).toBe('basic-sse-chat');
    expect(requestedProfileId('?profile=')).toBeUndefined();
    expect(requestedProfileId('?other=basic-sse-chat')).toBeUndefined();
  });

  it('preserves other query parameters and fragments when switching profiles', () => {
    expect(profileUrl('http://localhost:9095/app/?theme=dark#main', 'my profile/1')).toBe('/app/?theme=dark&profile=my+profile%2F1#main');
  });
});
