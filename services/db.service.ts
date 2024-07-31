// services/db.ts

import fs from 'fs/promises';
import path from 'path';

export enum CollectionName {
  Sessions = 'sessions',
  Investments = 'investments',
}

interface Identifiable {
  id: string;
}

export class DBService {
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data');
  }

  private async ensureDirectoryExists(): Promise<void> {
    try {
      await fs.access(this.dbPath);
    } catch {
      await fs.mkdir(this.dbPath, { recursive: true });
    }
  }

  private getCollectionPath(collectionName: CollectionName): string {
    return path.join(this.dbPath, `${collectionName}.json`);
  }

  private async loadCollection<T extends Identifiable>(collectionName: CollectionName): Promise<T[]> {
    await this.ensureDirectoryExists();
    const collectionPath = this.getCollectionPath(collectionName);

    try {
      const serialData = await fs.readFile(collectionPath, 'utf-8');
      return JSON.parse(serialData) as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw new Error(`Failed to load collection ${collectionName}: ${error}`);
    }
  }

  private async writeCollection<T extends Identifiable>(collectionName: CollectionName, data: T[]): Promise<void> {
    await this.ensureDirectoryExists();
    const collectionPath = this.getCollectionPath(collectionName);
    const serialData = JSON.stringify(data, null, 2);

    try {
      await fs.writeFile(collectionPath, serialData, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to write collection ${collectionName}: ${error}`);
    }
  }

  public async saveItem<T extends Identifiable>(collectionName: CollectionName, item: T): Promise<void> {
    const collectionItems = await this.loadCollection<T>(collectionName);
    const existingItemIndex = collectionItems.findIndex((_item) => _item.id === item.id);

    if (existingItemIndex === -1) {
      collectionItems.push(item);
    } else {
      collectionItems[existingItemIndex] = item;
    }

    await this.writeCollection(collectionName, collectionItems);
  }

  public async getItem<T extends Identifiable>(collectionName: CollectionName, id: string): Promise<T> {
    const collectionItems = await this.loadCollection<T>(collectionName);
    const item = collectionItems.find((_item) => _item.id === id);

    if (!item) {
      throw new Error(`Item with id ${id} not found in collection ${collectionName}`);
    }

    return item;
  }

  public async getAllItems<T extends Identifiable>(collectionName: CollectionName): Promise<T[]> {
    return this.loadCollection<T>(collectionName);
  }

  public async deleteItem(collectionName: CollectionName, id: string): Promise<void> {
    const collectionItems = await this.loadCollection<Identifiable>(collectionName);
    const updatedItems = collectionItems.filter(item => item.id !== id);

    if (updatedItems.length === collectionItems.length) {
      throw new Error(`Item with id ${id} not found in collection ${collectionName}`);
    }

    await this.writeCollection(collectionName, updatedItems);
  }
}

// Create a single instance to be used across the application
const db = new DBService();

export default db;