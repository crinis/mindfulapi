import { IsOptional, IsString } from 'class-validator';
import { Language } from '../types/language.types';

export class ScanQueryDto {
  @IsOptional()
  @IsString()
  language?: Language;
}
