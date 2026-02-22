import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { BasicAuth } from './axe-accessibility-scanner.service';

/**
 * Encrypted payload pair for persisted HTTP Basic Authentication credentials.
 */
export interface EncryptedBasicAuthCredentials {
  encryptedUsername: string;
  encryptedPassword: string;
}

const CREDENTIALS_CIPHER = 'aes-256-gcm';
const CREDENTIALS_VERSION = 'v1';
const CREDENTIALS_IV_BYTES = 12;
const ENCRYPTION_KEY_ENV_NAME = 'ENCRYPTION_KEY';

/**
 * Encrypts and decrypts HTTP Basic Authentication credentials for at-rest storage.
 */
@Injectable()
export class BasicAuthCryptoService {
  private encryptionKey?: Buffer;

  /**
   * Encrypts a basic-auth credential pair.
   */
  encryptCredentials(credentials: BasicAuth): EncryptedBasicAuthCredentials {
    return {
      encryptedUsername: this.encrypt(credentials.username),
      encryptedPassword: this.encrypt(credentials.password),
    };
  }

  /**
   * Decrypts a persisted basic-auth credential pair.
   */
  decryptCredentials(
    encryptedUsername: string,
    encryptedPassword: string,
  ): BasicAuth {
    return {
      username: this.decrypt(encryptedUsername),
      password: this.decrypt(encryptedPassword),
    };
  }

  private encrypt(value: string): string {
    const key = this.getKeyOrThrow();
    const iv = randomBytes(CREDENTIALS_IV_BYTES);
    const cipher = createCipheriv(CREDENTIALS_CIPHER, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      CREDENTIALS_VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  }

  private decrypt(payload: string): string {
    const [version, ivBase64, authTagBase64, encryptedBase64] =
      payload.split(':');
    if (
      version !== CREDENTIALS_VERSION ||
      !ivBase64 ||
      !authTagBase64 ||
      !encryptedBase64
    ) {
      throw new InternalServerErrorException(
        'Invalid encrypted basic auth payload format.',
      );
    }

    const key = this.getKeyOrThrow();
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');
    const encrypted = Buffer.from(encryptedBase64, 'base64');
    const decipher = createDecipheriv(CREDENTIALS_CIPHER, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  }

  private getKeyOrThrow(): Buffer {
    if (this.encryptionKey) return this.encryptionKey;

    const raw = process.env[ENCRYPTION_KEY_ENV_NAME]?.trim();
    const parsed = raw ? this.parseKey(raw) : null;
    if (!parsed) {
      throw new InternalServerErrorException(
        `${ENCRYPTION_KEY_ENV_NAME} must be set to a valid 32-byte base64 or hex key when encrypted credentials are used.`,
      );
    }

    this.encryptionKey = parsed;
    return parsed;
  }

  private parseKey(raw: string): Buffer | null {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }

    if (!/^[A-Za-z0-9+/=]+$/.test(raw)) {
      return null;
    }

    const parsed = Buffer.from(raw, 'base64');
    return parsed.length === 32 ? parsed : null;
  }
}
