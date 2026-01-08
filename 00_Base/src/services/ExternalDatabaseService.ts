// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { Inject, Service } from 'typedi';
import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { ILogObj, Logger } from 'tslog';
import { OcpiConfig, OcpiConfigToken } from '../config/ocpi.types';

/**
 * Service for executing queries against an external PostgreSQL database
 * Supports SELECT, INSERT, UPDATE, DELETE operations
 */
@Service()
export class ExternalDatabaseService {
  private pool: Pool;

  constructor(
    protected logger: Logger<ILogObj>,
    @Inject(OcpiConfigToken) protected config: OcpiConfig,
  ) {
    const poolConfig: PoolConfig = {
      host: config.rexhargeGatewayDatabase.host,
      port: config.rexhargeGatewayDatabase.port,
      database: config.rexhargeGatewayDatabase.database,
      user: config.rexhargeGatewayDatabase.username,
      password: config.rexhargeGatewayDatabase.password,
      max: 20, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection cannot be established
    };

    this.pool = new Pool(poolConfig);

    // Handle pool errors
    this.pool.on('error', (err) => {
      this.logger.error('Unexpected error on idle PostgreSQL client', err);
    });

    this.logger.info('ExternalDatabaseService PostgreSQL pool initialized');
  }

  /**
   * Execute a raw SQL query with parameters
   * @param query - SQL query string
   * @param params - Query parameters
   * @returns Query result
   */
  async query<T extends QueryResultRow = any>(
    query: string,
    params?: any[],
  ): Promise<QueryResult<T>> {
    try {
      return await this.pool.query<T>(query, params);
    } catch (error) {
      this.logger.error(`Failed to execute query: ${query}`, error);
      throw error;
    }
  }

  /**
   * Execute an INSERT query
   * @param table - Table name
   * @param data - Object with column names and values
   * @returns Inserted row(s)
   */
  async insert<T extends QueryResultRow = any>(
    table: string,
    data: Record<string, any>,
  ): Promise<T | null> {
    try {
      const columns = Object.keys(data);
      const values = Object.values(data);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

      const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`;
      const result = await this.pool.query<T>(query, values);

      return result.rows[0] || null;
    } catch (error) {
      this.logger.error(`Failed to insert into ${table}`, error);
      throw error;
    }
  }

  /**
   * Execute an UPDATE query
   * @param table - Table name
   * @param data - Object with column names and values to update
   * @param where - WHERE clause conditions
   * @param whereParams - Parameters for WHERE clause
   * @returns Updated row(s)
   */
  async update<T extends QueryResultRow = any>(
    table: string,
    data: Record<string, any>,
    where: string,
    whereParams?: any[],
  ): Promise<T[]> {
    try {
      const columns = Object.keys(data);
      const values = Object.values(data);
      const setClauses = columns
        .map((col, i) => `${col} = $${i + 1}`)
        .join(', ');

      const allParams = [...values, ...(whereParams || [])];
      const query = `UPDATE ${table} SET ${setClauses} WHERE ${where} RETURNING *`;
      const result = await this.pool.query<T>(query, allParams);

      return result.rows;
    } catch (error) {
      this.logger.error(`Failed to update ${table}`, error);
      throw error;
    }
  }

  /**
   * Execute a DELETE query
   * @param table - Table name
   * @param where - WHERE clause conditions
   * @param whereParams - Parameters for WHERE clause
   * @returns Deleted row(s)
   */
  async delete<T extends QueryResultRow = any>(
    table: string,
    where: string,
    whereParams?: any[],
  ): Promise<T[]> {
    try {
      const query = `DELETE FROM ${table} WHERE ${where} RETURNING *`;
      const result = await this.pool.query<T>(query, whereParams);

      return result.rows;
    } catch (error) {
      this.logger.error(`Failed to delete from ${table}`, error);
      throw error;
    }
  }

  /**
   * Execute a SELECT query
   * @param table - Table name
   * @param columns - Columns to select (default: '*')
   * @param where - WHERE clause conditions (optional)
   * @param whereParams - Parameters for WHERE clause
   * @returns Selected row(s)
   */
  async select<T extends QueryResultRow = any>(
    table: string,
    columns: string = '*',
    where?: string,
    whereParams?: any[],
  ): Promise<T[]> {
    try {
      const query = where
        ? `SELECT ${columns} FROM ${table} WHERE ${where}`
        : `SELECT ${columns} FROM ${table}`;
      const result = await this.pool.query<T>(query, whereParams);

      return result.rows;
    } catch (error) {
      this.logger.error(`Failed to select from ${table}`, error);
      throw error;
    }
  }

  /**
   * Closes the database pool
   * Should be called during application shutdown
   */
  async close(): Promise<void> {
    try {
      await this.pool.end();
      this.logger.info('ExternalDatabaseService PostgreSQL pool closed');
    } catch (error) {
      this.logger.error('Error closing PostgreSQL pool', error);
    }
  }

  /**
   * Gets the current pool status for monitoring
   */
  getPoolStatus() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }
}
